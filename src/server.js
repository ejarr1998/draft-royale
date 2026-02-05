const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIGURATION
// ============================================
const DRAFT_TIME_PER_PICK = 30; // seconds
const ROSTER_SIZE = 5;
const SCORE_UPDATE_INTERVAL = 30000; // 30 seconds

// Scoring systems
const SCORING = {
  nba: {
    points: 1,
    rebounds: 1.5,
    assists: 2,
    steals: 3,
    blocks: 3,
    doubleDouble: 5,
    tripleDouble: 10
  },
  nhl: {
    goals: 5,
    assists: 3,
    shotsOnGoal: 1,
    blockedShots: 2,
    saves: 0.5,
    shutout: 5,
    hatTrick: 3
  }
};

// ============================================
// GLOBAL CACHES
// ============================================

// NHL player stats cache — avoids re-fetching landing pages during enrichment
// Key: athleteId -> { data, timestamp }
const nhlPlayerStatsCache = new Map();
const NHL_STATS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes (season avgs don't change mid-game)

// NBA player stats cache
const nbaPlayerStatsCache = new Map();
const NBA_STATS_CACHE_TTL = 30 * 60 * 1000;

// Schedule cache — avoids re-fetching the same day's schedule
const scheduleCache = new Map();
const SCHEDULE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes for schedule (games can start)

// Game log cache — avoids redundant API calls when opening the same player modal
const gameLogCache = new Map();
const GAMELOG_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Live boxscore cache — avoids hammering APIs during score updates
const boxscoreCache = new Map();
const BOXSCORE_CACHE_TTL = 25 * 1000; // 25 seconds (just under the 30s poll interval)

// NHL roster cache — team rosters don't change during a session
const nhlRosterCache = new Map();
const NHL_ROSTER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// NBA roster cache
const nbaRosterCache = new Map();
const NBA_ROSTER_CACHE_TTL = 60 * 60 * 1000;

// ============================================
// CACHE HELPERS
// ============================================
function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < ttl) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(cache, key, data, maxSize = 1000) {
  cache.set(key, { data, timestamp: Date.now() });
  // Evict oldest if too large
  if (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// Rate-limited fetch helper with retries
async function fetchWithRetry(url, { maxRetries = 2, baseDelay = 800, label = '' } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 200;
        if (attempt < maxRetries) {
          console.log(`Rate limited${label ? ` (${label})` : ''}, retry in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`Rate limited${label ? ` (${label})` : ''}, exhausted retries`);
        return null;
      }
      if (!res.ok) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, baseDelay));
          continue;
        }
        return null;
      }
      return await res.json();
    } catch (e) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay));
        continue;
      }
      console.error(`Fetch failed${label ? ` (${label})` : ''}: ${e.message}`);
      return null;
    }
  }
  return null;
}

// ============================================
// STATE
// ============================================
const lobbies = {};      // lobbyId -> lobby object
const publicLobbies = []; // list of lobbyIds waiting for players
const sessions = {};     // sessionId -> { lobbyId, socketId, playerName }

// ============================================
// LOBBY MANAGEMENT
// ============================================
function createLobby(hostName, maxPlayers, isPublic, settings = {}) {
  const lobbyId = uuidv4().slice(0, 6).toUpperCase();
  
  lobbies[lobbyId] = {
    id: lobbyId,
    host: null, // set when host connects via socket
    hostName,
    maxPlayers: Math.min(Math.max(maxPlayers, 1), 8),
    isPublic,
    state: 'waiting', // waiting -> drafting -> live -> finished
    players: [],
    draftOrder: [],
    currentPick: 0,
    draftTimer: null,
    availablePlayers: [],
    games: [],
    scoreInterval: null,
    createdAt: Date.now(),
    // Configurable settings
    settings: {
      draftType: settings.draftType || 'snake',       // 'snake' | 'linear'
      timePerPick: Math.min(Math.max(settings.timePerPick || 30, 10), 120),  // 10-120 seconds
      leagues: settings.leagues || 'both',              // 'nba' | 'nhl' | 'both'
      rosterSlots: settings.rosterSlots || { nba: 4, nhl: 2 },  // picks per league
      gameDate: settings.gameDate || null,              // null = today, or ISO date string
    }
  };
  
  if (isPublic) {
    publicLobbies.push(lobbyId);
  }
  
  return lobbies[lobbyId];
}

function getRosterSize(settings) {
  const slots = settings.rosterSlots || { nba: 4, nhl: 2 };
  if (settings.leagues === 'nba') return slots.nba || 5;
  if (settings.leagues === 'nhl') return slots.nhl || 5;
  return (slots.nba || 0) + (slots.nhl || 0);
}

function generateDraftOrder(players, rosterSize, draftType = 'snake') {
  const order = [];
  const numPlayers = players.length;
  
  for (let round = 0; round < rosterSize; round++) {
    if (draftType === 'snake' && round % 2 === 1) {
      for (let i = numPlayers - 1; i >= 0; i--) {
        order.push(players[i].id);
      }
    } else {
      for (let i = 0; i < numPlayers; i++) {
        order.push(players[i].id);
      }
    }
  }
  
  return order;
}

// ============================================
// SPORTS API - FETCH TODAY'S GAMES & PLAYERS
// ============================================
async function fetchNBAGames(targetDate) {
  const cacheKey = `nba-${targetDate || 'today'}`;
  const cached = getCached(scheduleCache, cacheKey, SCHEDULE_CACHE_TTL);
  if (cached) return cached;

  try {
    let dateStr;
    if (targetDate) {
      const parts = targetDate.split('-');
      dateStr = parts.join('');
    } else {
      const d = new Date();
      dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }
    const data = await fetchWithRetry(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`,
      { label: 'NBA schedule' }
    );
    if (!data) return [];
    
    const games = (data.events || []).map(event => {
      const home = event.competitions[0].competitors.find(c => c.homeAway === 'home');
      const away = event.competitions[0].competitors.find(c => c.homeAway === 'away');
      return {
        gameId: event.id,
        league: 'nba',
        homeTeam: home?.team?.abbreviation,
        awayTeam: away?.team?.abbreviation,
        homeTeamId: home?.team?.id,
        awayTeamId: away?.team?.id,
        homeName: home?.team?.displayName,
        awayName: away?.team?.displayName,
        startTime: new Date(event.date),
        state: event.status?.type?.state,
        status: event.status?.type?.shortDetail
      };
    });

    setCache(scheduleCache, cacheKey, games, 50);
    return games;
  } catch (err) {
    console.error('Error fetching NBA games:', err);
    return [];
  }
}

async function fetchNHLGames(targetDate) {
  const cacheKey = `nhl-${targetDate || 'today'}`;
  const cached = getCached(scheduleCache, cacheKey, SCHEDULE_CACHE_TTL);
  if (cached) return cached;

  try {
    let dateStr;
    if (targetDate) {
      dateStr = targetDate;
    } else {
      const d = new Date();
      dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const data = await fetchWithRetry(
      `https://api-web.nhle.com/v1/schedule/${dateStr}`,
      { label: 'NHL schedule' }
    );
    if (!data) return [];
    
    const games = [];
    for (const day of data.gameWeek || []) {
      if (day.date === dateStr) {
        for (const game of day.games || []) {
          games.push({
            gameId: String(game.id),
            league: 'nhl',
            homeTeam: game.homeTeam?.abbrev,
            awayTeam: game.awayTeam?.abbrev,
            homeName: game.homeTeam?.placeName?.default + ' ' + (game.homeTeam?.commonName?.default || ''),
            awayName: game.awayTeam?.placeName?.default + ' ' + (game.awayTeam?.commonName?.default || ''),
            startTime: new Date(game.startTimeUTC),
            state: game.gameState,
            status: game.gameState === 'LIVE' ? 'In Progress' : game.gameState
          });
        }
      }
    }

    setCache(scheduleCache, cacheKey, games, 50);
    return games;
  } catch (err) {
    console.error('Error fetching NHL games:', err);
    return [];
  }
}

async function fetchNBAPlayersForGames(games) {
  const players = [];
  
  for (const game of games) {
    const teams = [
      { id: game.homeTeamId, abbrev: game.homeTeam, name: game.homeName },
      { id: game.awayTeamId, abbrev: game.awayTeam, name: game.awayName }
    ];
    
    let gotPlayers = false;
    
    for (const team of teams) {
      if (!team.id) continue;

      // Check roster cache first
      const rosterKey = `nba-${team.id}`;
      const cachedRoster = getCached(nbaRosterCache, rosterKey, NBA_ROSTER_CACHE_TTL);
      
      let athletes;
      if (cachedRoster) {
        athletes = cachedRoster;
      } else {
        try {
          const data = await fetchWithRetry(
            `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.id}/roster`,
            { label: `NBA roster ${team.abbrev}` }
          );
          athletes = data?.athletes || [];
          if (athletes.length > 0) {
            setCache(nbaRosterCache, rosterKey, athletes, 100);
          }
        } catch (teamErr) {
          console.error(`Error fetching NBA roster for team ${team.abbrev} (${team.id}):`, teamErr.message);
          athletes = [];
        }
      }

      for (const athlete of athletes) {
        if (athlete.displayName) {
          players.push({
            id: `nba-${athlete.id}`,
            athleteId: athlete.id,
            name: athlete.displayName,
            team: team.abbrev,
            teamName: team.name,
            league: 'nba',
            position: athlete.position?.abbreviation || 'N/A',
            gameId: game.gameId,
            headshot: athlete.headshot?.href || null,
            stats: { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0 },
            fantasyScore: 0,
            seasonAvg: { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0 },
            projectedScore: 0
          });
          gotPlayers = true;
        }
      }
    }
    
    // Fallback: summary endpoint for in-progress/completed games
    if (!gotPlayers) {
      try {
        const data = await fetchWithRetry(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.gameId}`,
          { label: `NBA summary ${game.gameId}` }
        );
        if (data) {
          for (const roster of data.rosters || []) {
            const teamAbbrev = roster.team?.abbreviation;
            const teamName = roster.team?.displayName;
            for (const entry of roster.roster || []) {
              const athlete = entry.athlete || entry;
              if (athlete.displayName) {
                players.push({
                  id: `nba-${athlete.id}`,
                  athleteId: athlete.id,
                  name: athlete.displayName,
                  team: teamAbbrev,
                  teamName: teamName,
                  league: 'nba',
                  position: athlete.position?.abbreviation || 'N/A',
                  gameId: game.gameId,
                  headshot: athlete.headshot?.href || null,
                  stats: { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0 },
                  fantasyScore: 0,
                  seasonAvg: { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0 },
                  projectedScore: 0
                });
              }
            }
          }
        }
      } catch (err) {
        console.error(`Error fetching NBA summary fallback for game ${game.gameId}:`, err);
      }
    }
  }
  
  return players;
}

async function fetchNHLPlayersForGames(games) {
  const players = [];
  
  for (const game of games) {
    const teams = [
      { abbrev: game.homeTeam, name: game.homeName },
      { abbrev: game.awayTeam, name: game.awayName }
    ];
    
    for (const team of teams) {
      // Check roster cache
      const rosterKey = `nhl-${team.abbrev}`;
      const cachedRoster = getCached(nhlRosterCache, rosterKey, NHL_ROSTER_CACHE_TTL);

      let rosterData;
      if (cachedRoster) {
        rosterData = cachedRoster;
      } else {
        try {
          const data = await fetchWithRetry(
            `https://api-web.nhle.com/v1/roster/${team.abbrev}/current`,
            { label: `NHL roster ${team.abbrev}` }
          );
          if (data) {
            rosterData = data;
            setCache(nhlRosterCache, rosterKey, data, 100);
          } else {
            continue;
          }
        } catch (teamErr) {
          console.error(`Error fetching roster for ${team.abbrev}:`, teamErr.message);
          continue;
        }
      }

      for (const posGroup of ['forwards', 'defensemen', 'goalies']) {
        for (const player of (rosterData[posGroup] || [])) {
          const position = posGroup === 'forwards' ? player.positionCode || 'F' :
                          posGroup === 'defensemen' ? 'D' : 'G';
          const isGoalie = posGroup === 'goalies';
          
          players.push({
            id: `nhl-${player.id}`,
            athleteId: player.id,
            name: `${player.firstName?.default || ''} ${player.lastName?.default || ''}`.trim(),
            team: team.abbrev,
            teamName: team.name?.trim(),
            league: 'nhl',
            position: position,
            gameId: game.gameId,
            headshot: player.headshot || null,
            stats: isGoalie ? 
              { saves: 0, goalsAgainst: 0 } :
              { goals: 0, assists: 0, shotsOnGoal: 0, blockedShots: 0 },
            fantasyScore: 0,
            isGoalie: isGoalie,
            seasonAvg: isGoalie ? { saves: 0, goalsAgainst: 0 } : { goals: 0, assists: 0, shotsOnGoal: 0, blockedShots: 0 },
            projectedScore: 0
          });
        }
      }
    }
  }
  
  return players;
}

// Fetch season averages for NBA players in bulk (one call per athlete)
async function enrichNBAPlayerAverages(players) {
  const nbaPlayers = players.filter(p => p.league === 'nba');
  
  const BATCH_SIZE = 8;
  const BATCH_DELAY = 400;
  
  for (let i = 0; i < nbaPlayers.length; i += BATCH_SIZE) {
    const batch = nbaPlayers.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (player) => {
      // Check cache first
      const cacheKey = player.athleteId;
      const cached = getCached(nbaPlayerStatsCache, cacheKey, NBA_STATS_CACHE_TTL);
      if (cached) {
        player.seasonAvg = cached.seasonAvg;
        player.projectedScore = cached.projectedScore;
        return;
      }

      try {
        const data = await fetchWithRetry(
          `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${player.athleteId}/stats`,
          { label: `NBA stats ${player.name}`, maxRetries: 1 }
        );
        if (!data) return;
        
        const categories = data.categories || [];
        const avgCat = categories.find(c => c.name === 'averages' || c.displayName?.includes('Average'));
        
        if (avgCat && avgCat.labels && avgCat.statistics && avgCat.statistics.length > 0) {
          const labels = avgCat.labels;
          const latestSeason = avgCat.statistics[avgCat.statistics.length - 1];
          const vals = latestSeason.stats || [];
          
          const idx = (name) => labels.indexOf(name);
          player.seasonAvg = {
            points: parseFloat(vals[idx('PTS')]) || 0,
            rebounds: parseFloat(vals[idx('REB')]) || 0,
            assists: parseFloat(vals[idx('AST')]) || 0,
            steals: parseFloat(vals[idx('STL')]) || 0,
            blocks: parseFloat(vals[idx('BLK')]) || 0
          };
        }
        
        // Fallback: perGame category
        if (player.seasonAvg.points === 0) {
          for (const cat of categories) {
            if (cat.type === 'perGame' || cat.name === 'perGame') {
              const labels = cat.labels || cat.names || [];
              const vals = cat.stats || cat.values || cat.totals || [];
              const idx = (name) => labels.indexOf(name);
              player.seasonAvg = {
                points: parseFloat(vals[idx('PTS')]) || 0,
                rebounds: parseFloat(vals[idx('REB')]) || 0,
                assists: parseFloat(vals[idx('AST')]) || 0,
                steals: parseFloat(vals[idx('STL')]) || 0,
                blocks: parseFloat(vals[idx('BLK')]) || 0
              };
              if (player.seasonAvg.points > 0) break;
            }
          }
        }
        
        // Fallback: splits
        if (player.seasonAvg.points === 0) {
          const splits = data.splits || {};
          const perGame = splits.categories?.find(c => c.name === 'general' || c.type === 'perGame');
          if (perGame) {
            const stats = perGame.stats || [];
            for (const s of stats) {
              if (s.name === 'avgPoints' || s.abbreviation === 'PTS') player.seasonAvg.points = parseFloat(s.value) || 0;
              if (s.name === 'avgRebounds' || s.abbreviation === 'REB') player.seasonAvg.rebounds = parseFloat(s.value) || 0;
              if (s.name === 'avgAssists' || s.abbreviation === 'AST') player.seasonAvg.assists = parseFloat(s.value) || 0;
              if (s.name === 'avgSteals' || s.abbreviation === 'STL') player.seasonAvg.steals = parseFloat(s.value) || 0;
              if (s.name === 'avgBlocks' || s.abbreviation === 'BLK') player.seasonAvg.blocks = parseFloat(s.value) || 0;
            }
          }
        }
        
        // Calculate projection
        const a = player.seasonAvg;
        player.projectedScore = Math.round(((a.points * SCORING.nba.points) + (a.rebounds * SCORING.nba.rebounds) +
          (a.assists * SCORING.nba.assists) + (a.steals * SCORING.nba.steals) + (a.blocks * SCORING.nba.blocks)) * 10) / 10;

        // Cache the result
        setCache(nbaPlayerStatsCache, cacheKey, {
          seasonAvg: player.seasonAvg,
          projectedScore: player.projectedScore
        }, 2000);
      } catch (e) {
        // Silently fail - player keeps default 0 projections
      }
    }));
    
    if (i + BATCH_SIZE < nbaPlayers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
}

// ============================================
// NHL ENRICHMENT — FIXED VERSION
// ============================================
// The NHL /player/{id}/landing endpoint returns stats in several possible locations:
//   1. featuredStats.regularSeason.subSeason  (most common for active players)
//   2. featuredStats.regularSeason.career      (fallback)
//   3. careerTotals.regularSeason              (always present if player has NHL stats)
//   4. last5Games[]                            (recent game log, can derive per-game)
//
// The previous code only checked #1, causing many players to show 0 projections.
// This version checks all four sources and uses smarter batching to avoid 429s.

async function enrichNHLPlayerAverages(players) {
  const nhlPlayers = players.filter(p => p.league === 'nhl');
  
  // Smaller batches + longer delays to respect NHL API rate limits
  const BATCH_SIZE = 5;
  const BATCH_DELAY = 800;
  
  let enriched = 0, cached = 0, failed = 0;
  
  for (let i = 0; i < nhlPlayers.length; i += BATCH_SIZE) {
    const batch = nhlPlayers.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (player) => {
      // Check cache first
      const cacheKey = player.athleteId;
      const cachedStats = getCached(nhlPlayerStatsCache, cacheKey, NHL_STATS_CACHE_TTL);
      if (cachedStats) {
        player.seasonAvg = cachedStats.seasonAvg;
        player.projectedScore = cachedStats.projectedScore;
        cached++;
        return;
      }

      const data = await fetchWithRetry(
        `https://api-web.nhle.com/v1/player/${player.athleteId}/landing`,
        { label: `NHL stats ${player.name}`, maxRetries: 2, baseDelay: 1000 }
      );

      if (!data) {
        failed++;
        return;
      }

      let gotStats = false;

      // ─── Source 1: featuredStats.regularSeason.subSeason (current season) ───
      const subSeason = data.featuredStats?.regularSeason?.subSeason;
      if (subSeason && subSeason.gamesPlayed > 0) {
        gotStats = extractNHLStats(player, subSeason);
      }

      // ─── Source 2: last5Games[] — derive per-game averages ───
      if (!gotStats && data.last5Games && data.last5Games.length > 0) {
        gotStats = extractNHLStatsFromGameLog(player, data.last5Games);
      }

      // ─── Source 3: careerTotals.regularSeason (lifetime averages) ───
      if (!gotStats) {
        const career = data.careerTotals?.regularSeason;
        if (career && career.gamesPlayed > 0) {
          gotStats = extractNHLStats(player, career);
        }
      }

      // ─── Source 4: seasonTotals[] — find the most recent season ───
      if (!gotStats && data.seasonTotals && data.seasonTotals.length > 0) {
        // Find the most recent regular season entry
        const recentSeason = data.seasonTotals
          .filter(s => s.gameTypeId === 2) // regular season
          .sort((a, b) => (b.season || 0) - (a.season || 0))[0];
        if (recentSeason && recentSeason.gamesPlayed > 0) {
          gotStats = extractNHLStats(player, recentSeason);
        }
      }

      if (gotStats) {
        enriched++;
      } else {
        failed++;
      }

      // Cache result regardless (even 0s — avoids re-fetching known-empty players)
      setCache(nhlPlayerStatsCache, cacheKey, {
        seasonAvg: player.seasonAvg,
        projectedScore: player.projectedScore
      }, 2000);
    }));
    
    // Wait between batches
    if (i + BATCH_SIZE < nhlPlayers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  console.log(`NHL enrichment: ${enriched} enriched, ${cached} from cache, ${failed} failed (${nhlPlayers.length} total)`);
}

// Extract stats from an NHL stats object (subSeason, career, or seasonTotals entry)
// Returns true if stats were successfully extracted
function extractNHLStats(player, statsObj) {
  const gp = statsObj.gamesPlayed || 1;

  if (player.isGoalie) {
    // Goalie stat fields vary: saves, savePctg, goalsAgainst, shotsAgainst
    const saves = statsObj.saves || 0;
    const goalsAgainst = statsObj.goalsAgainst || 0;
    // Sometimes only savePctg + shotsAgainst are available
    const shotsAgainst = statsObj.shotsAgainst || 0;
    const computedSaves = saves > 0 ? saves : (shotsAgainst > 0 ? shotsAgainst - goalsAgainst : 0);

    player.seasonAvg = {
      saves: Math.round((computedSaves / gp) * 10) / 10,
      goalsAgainst: Math.round((goalsAgainst / gp) * 10) / 10
    };
    player.projectedScore = Math.round((player.seasonAvg.saves * SCORING.nhl.saves) * 10) / 10;
    return player.seasonAvg.saves > 0 || player.seasonAvg.goalsAgainst > 0;
  } else {
    // Skater: goals, assists, shots (sometimes called 'shots', sometimes 'sog')
    const goals = statsObj.goals || 0;
    const assists = statsObj.assists || 0;
    const shots = statsObj.shots || statsObj.sog || statsObj.shotsOnGoal || 0;
    const blockedShots = statsObj.blockedShots || statsObj.blocked || 0;

    player.seasonAvg = {
      goals: Math.round((goals / gp) * 10) / 10,
      assists: Math.round((assists / gp) * 10) / 10,
      shotsOnGoal: Math.round((shots / gp) * 10) / 10,
      blockedShots: Math.round((blockedShots / gp) * 10) / 10
    };

    const a = player.seasonAvg;
    player.projectedScore = Math.round((
      (a.goals * SCORING.nhl.goals) +
      (a.assists * SCORING.nhl.assists) +
      (a.shotsOnGoal * SCORING.nhl.shotsOnGoal) +
      (a.blockedShots * SCORING.nhl.blockedShots)
    ) * 10) / 10;

    return goals > 0 || assists > 0 || shots > 0;
  }
}

// Extract stats from last5Games array (per-game objects)
function extractNHLStatsFromGameLog(player, games) {
  if (!games || games.length === 0) return false;
  const n = games.length;

  if (player.isGoalie) {
    let totalSaves = 0, totalGA = 0;
    for (const g of games) {
      // Goalie game log fields: savePctg, shotsAgainst, goalsAgainst, saves
      const saves = g.saves || 0;
      const goalsAgainst = g.goalsAgainst || 0;
      // Compute saves from shotsAgainst if saves field missing
      const shotsAgainst = g.shotsAgainst || 0;
      totalSaves += saves > 0 ? saves : Math.max(0, shotsAgainst - goalsAgainst);
      totalGA += goalsAgainst;
    }
    player.seasonAvg = {
      saves: Math.round((totalSaves / n) * 10) / 10,
      goalsAgainst: Math.round((totalGA / n) * 10) / 10
    };
    player.projectedScore = Math.round((player.seasonAvg.saves * SCORING.nhl.saves) * 10) / 10;
    return totalSaves > 0;
  } else {
    let totalGoals = 0, totalAssists = 0, totalShots = 0, totalBlocked = 0;
    for (const g of games) {
      totalGoals += g.goals || 0;
      totalAssists += g.assists || 0;
      totalShots += g.shots || g.sog || g.shotsOnGoal || 0;
      totalBlocked += g.blockedShots || g.blocked || 0;
    }
    player.seasonAvg = {
      goals: Math.round((totalGoals / n) * 10) / 10,
      assists: Math.round((totalAssists / n) * 10) / 10,
      shotsOnGoal: Math.round((totalShots / n) * 10) / 10,
      blockedShots: Math.round((totalBlocked / n) * 10) / 10
    };
    const a = player.seasonAvg;
    player.projectedScore = Math.round((
      (a.goals * SCORING.nhl.goals) +
      (a.assists * SCORING.nhl.assists) +
      (a.shotsOnGoal * SCORING.nhl.shotsOnGoal) +
      (a.blockedShots * SCORING.nhl.blockedShots)
    ) * 10) / 10;

    return totalGoals > 0 || totalAssists > 0 || totalShots > 0;
  }
}

// Assign tier badges based on projected fantasy score
function assignTierBadges(players) {
  const nbaPlayers = players.filter(p => p.league === 'nba');
  const nhlPlayers = players.filter(p => p.league === 'nhl');
  
  function assignTiers(list) {
    const sorted = [...list].sort((a, b) => (b.projectedScore || 0) - (a.projectedScore || 0));
    const total = sorted.length;
    if (total === 0) return;
    sorted.forEach((p, i) => {
      const pct = i / total;
      if (pct < 0.1) { p.tier = 'star'; p.tierLabel = '⭐ Star'; }
      else if (pct < 0.3) { p.tier = 'starter'; p.tierLabel = '🟢 Starter'; }
      else if (pct < 0.6) { p.tier = 'solid'; p.tierLabel = '🔵 Solid'; }
      else { p.tier = 'bench'; p.tierLabel = '⚪ Bench'; }
      const orig = list.find(op => op.id === p.id);
      if (orig) { orig.tier = p.tier; orig.tierLabel = p.tierLabel; }
    });
  }
  
  assignTiers(nbaPlayers);
  assignTiers(nhlPlayers);
}

// ============================================
// GAME LOG ENDPOINTS
// ============================================
function getCachedGameLog(league, athleteId) {
  return getCached(gameLogCache, `${league}-${athleteId}`, GAMELOG_CACHE_TTL);
}

function setCachedGameLog(league, athleteId, data) {
  setCache(gameLogCache, `${league}-${athleteId}`, data, 500);
}

async function fetchNBAGameLog(athleteId) {
  const cached = getCachedGameLog('nba', athleteId);
  if (cached) return cached;

  const games = [];

  // Strategy 1: ESPN athlete stats endpoint
  try {
    const data = await fetchWithRetry(
      `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${athleteId}/stats`,
      { label: `NBA gamelog ${athleteId}`, maxRetries: 1 }
    );
    if (data) {
      const categories = data.categories || [];
      for (const cat of categories) {
        if (cat.type === 'gameLog' || cat.name === 'gameLog') {
          const labels = cat.labels || [];
          const events = cat.events || [];
          const ptsIdx = labels.indexOf('PTS');
          const rebIdx = labels.indexOf('REB');
          const astIdx = labels.indexOf('AST');
          const stlIdx = labels.indexOf('STL');
          const blkIdx = labels.indexOf('BLK');
          const minIdx = labels.indexOf('MIN');
          const last3 = events.slice(-3).reverse();
          for (const evt of last3) {
            const stats = evt.stats || [];
            games.push({
              date: evt.gameDate ? new Date(evt.gameDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?',
              opponent: formatOpponent(evt),
              stats: {
                points: parseInt(stats[ptsIdx]) || 0,
                rebounds: parseInt(stats[rebIdx]) || 0,
                assists: parseInt(stats[astIdx]) || 0,
                steals: parseInt(stats[stlIdx]) || 0,
                blocks: parseInt(stats[blkIdx]) || 0,
                minutes: stats[minIdx] || '0'
              }
            });
          }
          if (games.length > 0) break;
        }
      }
    }
  } catch (e) {
    console.log(`NBA stats endpoint failed for ${athleteId}: ${e.message}`);
  }

  // Strategy 2: ESPN gamelog endpoint
  if (games.length === 0) {
    try {
      const data = await fetchWithRetry(
        `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${athleteId}/gamelog`,
        { label: `NBA gamelog2 ${athleteId}`, maxRetries: 1 }
      );
      if (data) {
        let events = data.events || {};
        let labels = [];
        let statsByEvent = {};
        const allCategories = [];
        if (data.categories) allCategories.push(...data.categories);
        if (data.seasonTypes) {
          for (const season of data.seasonTypes) {
            if (season.categories) allCategories.push(...season.categories);
            if (season.events) {
              for (const [eid, evtData] of Object.entries(season.events)) {
                if (!events[eid]) events[eid] = evtData;
              }
            }
          }
        }
        for (const cat of allCategories) {
          if (cat.events && cat.labels) {
            labels = cat.labels;
            for (const evt of cat.events) {
              const eid = evt.eventId || evt.id;
              if (eid && evt.stats && evt.stats.length > 0) {
                statsByEvent[eid] = evt.stats;
              }
            }
          }
        }
        const eventsWithStats = Object.keys(statsByEvent);
        const last3 = eventsWithStats.slice(-3).reverse();
        const ptsIdx = labels.indexOf('PTS');
        const rebIdx = labels.indexOf('REB');
        const astIdx = labels.indexOf('AST');
        const stlIdx = labels.indexOf('STL');
        const blkIdx = labels.indexOf('BLK');
        const minIdx = labels.indexOf('MIN');
        for (const evtId of last3) {
          const evt = events[evtId] || {};
          const stats = statsByEvent[evtId] || [];
          games.push({
            date: evt.gameDate ? new Date(evt.gameDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?',
            opponent: formatOpponent(evt),
            stats: {
              points: parseInt(stats[ptsIdx]) || 0,
              rebounds: parseInt(stats[rebIdx]) || 0,
              assists: parseInt(stats[astIdx]) || 0,
              steals: parseInt(stats[stlIdx]) || 0,
              blocks: parseInt(stats[blkIdx]) || 0,
              minutes: stats[minIdx] || '0'
            }
          });
        }
      }
    } catch (e) {
      console.log(`NBA gamelog endpoint failed for ${athleteId}: ${e.message}`);
    }
  }

  setCachedGameLog('nba', athleteId, games);
  return games;
}

function formatOpponent(evt) {
  if (!evt || !evt.opponent) return '?';
  const prefix = evt.atVs === '@' || evt.homeAway === 'away' ? '@' : 'vs';
  return `${prefix} ${evt.opponent.abbreviation || evt.opponent.displayName || '?'}`;
}

async function fetchNHLGameLog(playerId) {
  const cached = getCachedGameLog('nhl', playerId);
  if (cached) return cached;

  try {
    const data = await fetchWithRetry(
      `https://api-web.nhle.com/v1/player/${playerId}/game-log/now`,
      { label: `NHL gamelog ${playerId}` }
    );
    if (!data) return [];
    
    const gameLog = data.gameLog || [];
    const last3 = gameLog.slice(0, 3);
    
    const games = last3.map(g => ({
      date: new Date(g.gameDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      opponent: `${g.homeRoadFlag === 'H' ? 'vs' : '@'} ${g.opponentAbbrev || '?'}`,
      stats: g.goals !== undefined ? {
        goals: g.goals || 0,
        assists: g.assists || 0,
        points: g.points || 0,
        shotsOnGoal: g.shots || 0,
        plusMinus: g.plusMinus || 0,
        toi: g.toi || '0:00'
      } : {
        saves: g.savePctg ? Math.round((g.shotsAgainst || 0) * (g.savePctg || 0)) : (g.saves || 0),
        goalsAgainst: g.goalsAgainst || 0,
        savePct: g.savePctg ? (g.savePctg * 100).toFixed(1) + '%' : '0%',
        toi: g.toi || '0:00'
      }
    }));

    setCachedGameLog('nhl', playerId, games);
    return games;
  } catch (e) {
    console.error(`Error fetching NHL game log for ${playerId}:`, e.message);
    return [];
  }
}

// ============================================
// LIVE SCORING
// ============================================
async function fetchLiveNBAStats(gameId) {
  // Check boxscore cache
  const cacheKey = `nba-box-${gameId}`;
  const cached = getCached(boxscoreCache, cacheKey, BOXSCORE_CACHE_TTL);
  if (cached) return cached;

  try {
    const data = await fetchWithRetry(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`,
      { label: `NBA boxscore ${gameId}`, maxRetries: 1 }
    );
    if (!data) return {};
    
    const playerStats = {};
    
    for (const team of data.boxscore?.players || []) {
      for (const statGroup of team.statistics || []) {
        const headers = statGroup.labels || [];
        const ptsIdx = headers.indexOf('PTS');
        const rebIdx = headers.indexOf('REB');
        const astIdx = headers.indexOf('AST');
        const stlIdx = headers.indexOf('STL');
        const blkIdx = headers.indexOf('BLK');
        
        for (const athlete of statGroup.athletes || []) {
          const stats = athlete.stats || [];
          const id = `nba-${athlete.athlete?.id}`;
          
          playerStats[id] = {
            points: parseInt(stats[ptsIdx]) || 0,
            rebounds: parseInt(stats[rebIdx]) || 0,
            assists: parseInt(stats[astIdx]) || 0,
            steals: parseInt(stats[stlIdx]) || 0,
            blocks: parseInt(stats[blkIdx]) || 0
          };
        }
      }
    }

    setCache(boxscoreCache, cacheKey, playerStats, 200);
    return playerStats;
  } catch (err) {
    console.error(`Error fetching NBA stats for ${gameId}:`, err);
    return {};
  }
}

async function fetchLiveNHLStats(gameId) {
  const cacheKey = `nhl-box-${gameId}`;
  const cached = getCached(boxscoreCache, cacheKey, BOXSCORE_CACHE_TTL);
  if (cached) return cached;

  try {
    const data = await fetchWithRetry(
      `https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`,
      { label: `NHL boxscore ${gameId}`, maxRetries: 1 }
    );
    if (!data) return {};
    
    const playerStats = {};
    
    for (const side of ['homeTeam', 'awayTeam']) {
      for (const posGroup of ['forwards', 'defense']) {
        for (const player of (data[side]?.[posGroup] || [])) {
          playerStats[`nhl-${player.playerId}`] = {
            goals: player.goals || 0,
            assists: player.assists || 0,
            shotsOnGoal: player.sog || 0,
            blockedShots: player.blockedShots || 0
          };
        }
      }
      
      for (const player of (data[side]?.goalies || [])) {
        playerStats[`nhl-${player.playerId}`] = {
          saves: player.saveShotsAgainst ? 
            (parseInt(player.saveShotsAgainst.split('/')[0]) || 0) : 0,
          goalsAgainst: player.goalsAgainst || 0,
          isGoalie: true
        };
      }
    }

    setCache(boxscoreCache, cacheKey, playerStats, 200);
    return playerStats;
  } catch (err) {
    console.error(`Error fetching NHL stats for ${gameId}:`, err);
    return {};
  }
}

function calculateFantasyScore(player) {
  const s = player.stats;
  
  if (player.league === 'nba') {
    let score = 0;
    score += (s.points || 0) * SCORING.nba.points;
    score += (s.rebounds || 0) * SCORING.nba.rebounds;
    score += (s.assists || 0) * SCORING.nba.assists;
    score += (s.steals || 0) * SCORING.nba.steals;
    score += (s.blocks || 0) * SCORING.nba.blocks;
    
    const cats = [s.points, s.rebounds, s.assists, s.steals, s.blocks].filter(v => v >= 10);
    if (cats.length >= 2) score += SCORING.nba.doubleDouble;
    if (cats.length >= 3) score += SCORING.nba.tripleDouble;
    
    return Math.round(score * 10) / 10;
  }
  
  if (player.league === 'nhl') {
    let score = 0;
    
    if (player.isGoalie) {
      score += (s.saves || 0) * SCORING.nhl.saves;
      if (s.goalsAgainst === 0 && s.saves > 0) score += SCORING.nhl.shutout;
    } else {
      score += (s.goals || 0) * SCORING.nhl.goals;
      score += (s.assists || 0) * SCORING.nhl.assists;
      score += (s.shotsOnGoal || 0) * SCORING.nhl.shotsOnGoal;
      score += (s.blockedShots || 0) * SCORING.nhl.blockedShots;
      if ((s.goals || 0) >= 3) score += SCORING.nhl.hatTrick;
    }
    
    return Math.round(score * 10) / 10;
  }
  
  return 0;
}

async function updateLiveScores(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.state !== 'live') return;
  
  const nbaGameIds = new Set();
  const nhlGameIds = new Set();
  
  for (const player of lobby.players) {
    for (const pick of player.roster || []) {
      if (pick.league === 'nba') nbaGameIds.add(pick.gameId);
      if (pick.league === 'nhl') nhlGameIds.add(pick.gameId);
    }
  }
  
  const allStats = {};
  
  // Fetch all boxscores in parallel (within each league)
  const nbaPromises = [...nbaGameIds].map(id => fetchLiveNBAStats(id).then(s => Object.assign(allStats, s)));
  const nhlPromises = [...nhlGameIds].map(id => fetchLiveNHLStats(id).then(s => Object.assign(allStats, s)));
  await Promise.all([...nbaPromises, ...nhlPromises]);
  
  for (const player of lobby.players) {
    let totalScore = 0;
    for (const pick of player.roster || []) {
      if (allStats[pick.id]) {
        pick.stats = allStats[pick.id];
        pick.isGoalie = pick.isGoalie || allStats[pick.id].isGoalie;
      }
      pick.fantasyScore = calculateFantasyScore(pick);
      totalScore += pick.fantasyScore;
    }
    player.totalScore = Math.round(totalScore * 10) / 10;
  }
  
  // Check game states (use schedule cache — at most 1 fetch per league per 2 min)
  let allFinished = true;
  const hasNBA = lobby.games.some(g => g.league === 'nba');
  const hasNHL = lobby.games.some(g => g.league === 'nhl');
  const [nbaSchedule, nhlSchedule] = await Promise.all([
    hasNBA ? fetchNBAGames(lobby.gameDate) : Promise.resolve([]),
    hasNHL ? fetchNHLGames(lobby.gameDate) : Promise.resolve([])
  ]);

  const gameStatusMap = {};
  for (const g of nbaSchedule) gameStatusMap[g.gameId] = g.status || g.state;
  for (const g of nhlSchedule) gameStatusMap[g.gameId] = g.status || g.state;
  
  for (const player of lobby.players) {
    for (const pick of player.roster || []) {
      if (pick.gameId && gameStatusMap[pick.gameId]) {
        pick.gameStatus = gameStatusMap[pick.gameId];
      }
    }
  }

  for (const game of lobby.games) {
    if (game.league === 'nba') {
      const found = nbaSchedule.find(g => g.gameId === game.gameId);
      if (found) { game.state = found.state; game.status = found.status; }
      if (!found || found.state !== 'post') allFinished = false;
    }
    if (game.league === 'nhl') {
      const found = nhlSchedule.find(g => g.gameId === game.gameId);
      if (found) { game.state = found.state; game.status = found.status; }
      if (!found || (found.state !== 'OFF' && found.state !== 'FINAL')) allFinished = false;
    }
  }
  
  // Adaptive polling: slow when no games started, fast when live
  const anyStarted = lobby.games.some(g =>
    (g.league === 'nba' && g.state !== 'pre') ||
    (g.league === 'nhl' && g.state !== 'FUT')
  );
  if (!anyStarted && !allFinished) {
    if (lobby.scoreInterval && !lobby._slowPolling) {
      clearInterval(lobby.scoreInterval);
      lobby._slowPolling = true;
      lobby.scoreInterval = setInterval(() => updateLiveScores(lobbyId), 300000);
      console.log(`Lobby ${lobbyId}: games haven't started, slowing poll to 5min`);
    }
  } else if (anyStarted && lobby._slowPolling) {
    clearInterval(lobby.scoreInterval);
    lobby._slowPolling = false;
    lobby.scoreInterval = setInterval(() => updateLiveScores(lobbyId), SCORE_UPDATE_INTERVAL);
    console.log(`Lobby ${lobbyId}: games started, fast polling resumed`);
  }
  
  if (allFinished) {
    lobby.state = 'finished';
    clearInterval(lobby.scoreInterval);
    lobby.scoreInterval = null;
  }
  
  io.to(lobbyId).emit('scoreUpdate', {
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      roster: p.roster,
      totalScore: p.totalScore
    })),
    state: lobby.state
  });
}

// ============================================
// SOCKET.IO - REAL-TIME COMMUNICATION
// ============================================
function sanitizeName(name) {
  return String(name || 'Player').replace(/[<>"'&]/g, '').trim().slice(0, 20) || 'Player';
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  socket.on('createLobby', async ({ playerName, maxPlayers, isPublic, settings, sessionId }) => {
    if (sessions[sessionId] && lobbies[sessions[sessionId].lobbyId]) {
      return socket.emit('error', { message: 'You are already in a game' });
    }
    
    const safeName = sanitizeName(playerName);
    const lobby = createLobby(safeName, maxPlayers, isPublic, settings || {});
    
    const player = {
      id: sessionId,
      name: safeName,
      roster: [],
      totalScore: 0,
      isHost: true
    };
    
    lobby.players.push(player);
    lobby.host = sessionId;
    
    socket.join(lobby.id);
    socket.lobbyId = lobby.id;
    socket.sessionId = sessionId;
    
    sessions[sessionId] = { lobbyId: lobby.id, socketId: socket.id, playerName: safeName };
    
    socket.emit('lobbyCreated', {
      lobbyId: lobby.id,
      lobby: getLobbyState(lobby)
    });
    
    console.log(`Lobby ${lobby.id} created by ${playerName} (session ${sessionId})`);
  });

  socket.on('updateSettings', ({ settings }) => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby || socket.sessionId !== lobby.host || lobby.state !== 'waiting') return;
    
    if (settings.maxPlayers !== undefined) {
      lobby.maxPlayers = Math.min(Math.max(settings.maxPlayers, 1), 8);
    }
    if (settings.isPublic !== undefined) {
      lobby.isPublic = settings.isPublic;
      const idx = publicLobbies.indexOf(lobby.id);
      if (settings.isPublic && idx === -1) publicLobbies.push(lobby.id);
      if (!settings.isPublic && idx !== -1) publicLobbies.splice(idx, 1);
    }
    if (settings.draftType) lobby.settings.draftType = settings.draftType;
    if (settings.timePerPick) lobby.settings.timePerPick = Math.min(Math.max(settings.timePerPick, 10), 120);
    if (settings.leagues) lobby.settings.leagues = settings.leagues;
    if (settings.rosterSlots) {
      lobby.settings.rosterSlots = {
        nba: Math.min(Math.max(settings.rosterSlots.nba || 0, 0), 10),
        nhl: Math.min(Math.max(settings.rosterSlots.nhl || 0, 0), 10),
      };
    }
    if (settings.gameDate !== undefined) lobby.settings.gameDate = settings.gameDate;
    
    io.to(lobby.id).emit('lobbyUpdate', getLobbyState(lobby));
  });
  
  socket.on('joinLobby', ({ lobbyId, playerName, sessionId }) => {
    const code = lobbyId.toUpperCase();
    const safeName = sanitizeName(playerName);
    const lobby = lobbies[code];
    
    if (sessions[sessionId] && lobbies[sessions[sessionId].lobbyId]) {
      return socket.emit('error', { message: 'You are already in a game' });
    }
    
    if (!lobby) {
      return socket.emit('error', { message: 'Lobby not found' });
    }
    if (lobby.state !== 'waiting') {
      return socket.emit('error', { message: 'Game already in progress' });
    }
    if (lobby.players.length >= lobby.maxPlayers) {
      return socket.emit('error', { message: 'Lobby is full' });
    }
    
    const player = {
      id: sessionId,
      name: safeName,
      roster: [],
      totalScore: 0,
      isHost: false
    };
    
    lobby.players.push(player);
    socket.join(code);
    socket.lobbyId = code;
    socket.sessionId = sessionId;
    
    sessions[sessionId] = { lobbyId: code, socketId: socket.id, playerName: safeName };
    
    if (lobby.players.length >= lobby.maxPlayers) {
      const idx = publicLobbies.indexOf(code);
      if (idx !== -1) publicLobbies.splice(idx, 1);
    }
    
    io.to(code).emit('lobbyUpdate', getLobbyState(lobby));
    console.log(`${playerName} joined lobby ${code} (session ${sessionId})`);
  });
  
  socket.on('rejoin', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) {
      return socket.emit('rejoinFailed', { reason: 'no_session' });
    }
    
    const lobby = lobbies[session.lobbyId];
    if (!lobby) {
      delete sessions[sessionId];
      return socket.emit('rejoinFailed', { reason: 'lobby_gone' });
    }
    
    const player = lobby.players.find(p => p.id === sessionId);
    if (!player) {
      delete sessions[sessionId];
      return socket.emit('rejoinFailed', { reason: 'player_gone' });
    }
    
    session.socketId = socket.id;
    socket.lobbyId = lobby.id;
    socket.sessionId = sessionId;
    player.disconnected = false;
    
    socket.join(lobby.id);
    
    const lobbyStateData = getLobbyState(lobby);
    const playerIsHost = lobby.host === sessionId;
    
    if (lobby.state === 'waiting') {
      socket.emit('rejoinState', {
        phase: 'waiting',
        lobby: lobbyStateData,
        isHost: playerIsHost,
        sessionId
      });
    } else if (lobby.state === 'drafting') {
      const elapsed = lobby.pickStartedAt ? Math.floor((Date.now() - lobby.pickStartedAt) / 1000) : 0;
      const timeRemaining = Math.max((lobby.settings.timePerPick || 30) - elapsed, 1);
      
      socket.emit('rejoinState', {
        phase: 'drafting',
        lobby: lobbyStateData,
        isHost: playerIsHost,
        sessionId,
        availablePlayers: lobby.availablePlayers,
        draftOrder: lobby.draftOrder,
        currentPick: lobby.currentPick,
        currentDrafter: lobby.draftOrder[lobby.currentPick],
        timePerPick: timeRemaining,
        games: (lobby.games || [])
          .filter(g => (lobby.settings.leagues || 'both') === 'both' || g.league === lobby.settings.leagues)
          .map(g => ({
            gameId: g.gameId, league: g.league,
            homeTeam: g.homeTeam, awayTeam: g.awayTeam,
            homeName: g.homeName, awayName: g.awayName,
            startTime: g.startTime, state: g.state, status: g.status
          }))
      });
    } else {
      socket.emit('rejoinState', {
        phase: lobby.state,
        lobby: lobbyStateData,
        isHost: playerIsHost,
        sessionId,
        players: lobby.players.map(p => ({
          id: p.id, name: p.name, roster: p.roster, totalScore: p.totalScore
        }))
      });
    }
    
    io.to(lobby.id).emit('playerReconnected', { playerName: player.name });
    console.log(`${player.name} rejoined lobby ${lobby.id} (session ${sessionId})`);
  });
  
  socket.on('findPublicLobby', ({ playerName }) => {
    let found = null;
    for (const lobbyId of publicLobbies) {
      const lobby = lobbies[lobbyId];
      if (lobby && lobby.state === 'waiting' && lobby.players.length < lobby.maxPlayers) {
        found = lobbyId;
        break;
      }
    }
    if (found) {
      socket.emit('publicLobbyFound', { lobbyId: found });
    } else {
      socket.emit('error', { message: 'No public lobbies available. Create one!' });
    }
  });
  
  socket.on('startDraft', async () => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;
    if (socket.sessionId !== lobby.host) return;
    if (lobby.state === 'drafting') return;
    if (lobby.players.length < 1) {
      return socket.emit('error', { message: 'Need at least 1 player' });
    }
    
    lobby.state = 'drafting';
    const { draftType, timePerPick, leagues, gameDate } = lobby.settings;
    
    io.to(lobby.id).emit('draftLoading', { message: 'Fetching games & players...' });
    
    const fetchNBA = leagues === 'nba' || leagues === 'both';
    const fetchNHL = leagues === 'nhl' || leagues === 'both';
    
    const [nbaGames, nhlGames] = await Promise.all([
      fetchNBA ? fetchNBAGames(gameDate) : Promise.resolve([]),
      fetchNHL ? fetchNHLGames(gameDate) : Promise.resolve([])
    ]);
    
    const todayISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const isFutureDate = gameDate && gameDate !== todayISO;
    const upcomingNBA = isFutureDate ? nbaGames : nbaGames.filter(g => g.state !== 'post');
    const upcomingNHL = isFutureDate ? nhlGames : nhlGames.filter(g => g.state !== 'OFF' && g.state !== 'FINAL');
    
    lobby.games = [...nbaGames, ...nhlGames];
    lobby.gameDate = gameDate;
    
    if (upcomingNBA.length === 0 && upcomingNHL.length === 0) {
      lobby.state = 'waiting';
      const leagueStr = leagues === 'both' ? 'NBA or NHL' : leagues.toUpperCase();
      const dateLabel = isFutureDate ? ` on ${new Date(gameDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
      io.to(lobby.id).emit('draftLoadingDone');
      return socket.emit('error', { message: `No ${leagueStr} games found${dateLabel}!` });
    }
    
    const [nbaPlayers, nhlPlayers] = await Promise.all([
      upcomingNBA.length > 0 ? fetchNBAPlayersForGames(upcomingNBA) : Promise.resolve([]),
      upcomingNHL.length > 0 ? fetchNHLPlayersForGames(upcomingNHL) : Promise.resolve([])
    ]);
    
    lobby.availablePlayers = [...nbaPlayers, ...nhlPlayers];
    
    if (lobby.availablePlayers.length === 0) {
      lobby.state = 'waiting';
      io.to(lobby.id).emit('draftLoadingDone');
      return socket.emit('error', { message: 'No players available to draft. Try again when there are upcoming games.' });
    }
    
    io.to(lobby.id).emit('draftLoading', { message: `Loading stats for ${nbaPlayers.length + nhlPlayers.length} players...` });
    console.log(`Enriching ${nbaPlayers.length} NBA + ${nhlPlayers.length} NHL players with season stats...`);
    await Promise.all([
      nbaPlayers.length > 0 ? enrichNBAPlayerAverages(lobby.availablePlayers) : Promise.resolve(),
      nhlPlayers.length > 0 ? enrichNHLPlayerAverages(lobby.availablePlayers) : Promise.resolve()
    ]);
    
    // Filter NBA players to top 6 per team
    const NBA_PLAYERS_PER_TEAM = 6;
    const nbaByTeamGame = {};
    const nonNba = [];
    for (const p of lobby.availablePlayers) {
      if (p.league === 'nba') {
        const key = `${p.team}-${p.gameId}`;
        if (!nbaByTeamGame[key]) nbaByTeamGame[key] = [];
        nbaByTeamGame[key].push(p);
      } else {
        nonNba.push(p);
      }
    }
    const filteredNba = [];
    for (const players of Object.values(nbaByTeamGame)) {
      players.sort((a, b) => (b.projectedScore || 0) - (a.projectedScore || 0));
      filteredNba.push(...players.slice(0, NBA_PLAYERS_PER_TEAM));
    }
    lobby.availablePlayers = [...filteredNba, ...nonNba];
    
    const trimmedCount = nbaPlayers.length - filteredNba.length;
    if (trimmedCount > 0) {
      console.log(`Trimmed ${trimmedCount} low-value NBA players (kept top ${NBA_PLAYERS_PER_TEAM}/team)`);
    }
    
    assignTierBadges(lobby.availablePlayers);
    lobby.availablePlayers.sort((a, b) => (b.projectedScore || 0) - (a.projectedScore || 0));
    
    console.log(`Draft pool ready: ${upcomingNBA.length} NBA games (${filteredNba.length} players), ${upcomingNHL.length} NHL games (${nonNba.length} players) | Settings: ${draftType} draft, ${timePerPick}s/pick, leagues=${leagues}, slots=${JSON.stringify(lobby.settings.rosterSlots)}`);
    
    const rosterSize = getRosterSize(lobby.settings);
    const shuffled = [...lobby.players].sort(() => Math.random() - 0.5);
    lobby.draftOrder = generateDraftOrder(shuffled, rosterSize, draftType);
    lobby.currentPick = 0;
    
    io.to(lobby.id).emit('draftStart', {
      lobby: getLobbyState(lobby),
      availablePlayers: lobby.availablePlayers,
      draftOrder: lobby.draftOrder,
      currentPick: 0,
      currentDrafter: lobby.draftOrder[0],
      timePerPick: timePerPick,
      games: lobby.games
        .filter(g => leagues === 'both' || g.league === leagues)
        .map(g => ({
          gameId: g.gameId, league: g.league,
          homeTeam: g.homeTeam, awayTeam: g.awayTeam,
          homeName: g.homeName, awayName: g.awayName,
          startTime: g.startTime, state: g.state, status: g.status
        }))
    });
    
    startDraftTimer(lobby);
    console.log(`Draft started in lobby ${lobby.id}`);
  });
  
  socket.on('draftPick', ({ playerId }) => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby || lobby.state !== 'drafting') return;
    
    const currentDrafter = lobby.draftOrder[lobby.currentPick];
    if (socket.sessionId !== currentDrafter) return;
    
    const playerIdx = lobby.availablePlayers.findIndex(p => p.id === playerId);
    if (playerIdx === -1) return;
    
    const picked = lobby.availablePlayers[playerIdx];
    const drafter = lobby.players.find(p => p.id === socket.sessionId);
    
    const slots = lobby.settings.rosterSlots || { nba: 10, nhl: 10 };
    const leagues = lobby.settings.leagues;
    if (leagues === 'both' || leagues === picked.league) {
      const leagueCount = (drafter.roster || []).filter(r => r.league === picked.league).length;
      const maxForLeague = slots[picked.league] || 0;
      if (leagueCount >= maxForLeague) {
        return socket.emit('error', { message: `${picked.league.toUpperCase()} roster full (${maxForLeague}/${maxForLeague})` });
      }
    }
    
    lobby.availablePlayers.splice(playerIdx, 1);
    drafter.roster.push(picked);
    
    if (lobby.draftTimer) {
      clearTimeout(lobby.draftTimer);
      lobby.draftTimer = null;
    }
    
    lobby.currentPick++;
    
    io.to(lobby.id).emit('pickMade', {
      picker: { id: drafter.id, name: drafter.name },
      player: picked,
      pickNumber: lobby.currentPick - 1,
      availablePlayers: lobby.availablePlayers,
      players: lobby.players.map(p => ({
        id: p.id,
        name: p.name,
        roster: p.roster
      }))
    });
    
    if (lobby.currentPick >= lobby.draftOrder.length) {
      endDraft(lobby);
    } else {
      io.to(lobby.id).emit('nextPick', {
        currentPick: lobby.currentPick,
        currentDrafter: lobby.draftOrder[lobby.currentPick],
        timePerPick: lobby.settings.timePerPick
      });
      startDraftTimer(lobby);
    }
  });
  
  socket.on('chatMessage', ({ message }) => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.sessionId);
    if (!player) return;
    const safeMsg = String(message || '').replace(/[<>"'&]/g, '').trim().slice(0, 300);
    if (!safeMsg) return;
    io.to(lobby.id).emit('chatMessage', {
      from: player.name,
      message: safeMsg,
      timestamp: Date.now()
    });
  });
  
  socket.on('disconnect', () => {
    const lobbyId = socket.lobbyId;
    const sessionId = socket.sessionId;
    if (!lobbyId || !lobbies[lobbyId]) return;
    
    const lobby = lobbies[lobbyId];
    
    if (lobby.state === 'waiting') {
      lobby.players = lobby.players.filter(p => p.id !== sessionId);
      if (sessionId) delete sessions[sessionId];
      
      if (lobby.players.length === 0) {
        delete lobbies[lobbyId];
        const idx = publicLobbies.indexOf(lobbyId);
        if (idx !== -1) publicLobbies.splice(idx, 1);
      } else {
        if (lobby.host === sessionId) {
          lobby.host = lobby.players[0].id;
          lobby.players[0].isHost = true;
        }
        io.to(lobbyId).emit('lobbyUpdate', getLobbyState(lobby));
      }
    } else {
      const player = lobby.players.find(p => p.id === sessionId);
      if (player) {
        player.disconnected = true;
        io.to(lobbyId).emit('playerDisconnected', { playerName: player.name, sessionId });
      }
    }
    
    console.log(`Client disconnected: ${socket.id} (session ${sessionId || 'none'})`);
  });
});

// ============================================
// DRAFT TIMER
// ============================================
function startDraftTimer(lobby) {
  const timePerPick = lobby.settings.timePerPick || 30;
  lobby.pickStartedAt = Date.now();
  lobby.draftTimer = setTimeout(() => {
    const currentDrafter = lobby.draftOrder[lobby.currentPick];
    const drafter = lobby.players.find(p => p.id === currentDrafter);
    
    if (lobby.availablePlayers.length > 0 && drafter) {
      const slots = lobby.settings.rosterSlots || { nba: 10, nhl: 10 };
      const nbaCount = (drafter.roster || []).filter(r => r.league === 'nba').length;
      const nhlCount = (drafter.roster || []).filter(r => r.league === 'nhl').length;
      
      let autoIdx = lobby.availablePlayers.findIndex(p => {
        if (p.league === 'nba' && nbaCount >= (slots.nba || 0)) return false;
        if (p.league === 'nhl' && nhlCount >= (slots.nhl || 0)) return false;
        return true;
      });
      if (autoIdx === -1) autoIdx = 0;
      
      const autoPick = lobby.availablePlayers.splice(autoIdx, 1)[0];
      drafter.roster.push(autoPick);
      
      lobby.currentPick++;
      
      io.to(lobby.id).emit('pickMade', {
        picker: { id: drafter.id, name: drafter.name },
        player: autoPick,
        pickNumber: lobby.currentPick - 1,
        availablePlayers: lobby.availablePlayers,
        autoPick: true,
        players: lobby.players.map(p => ({
          id: p.id,
          name: p.name,
          roster: p.roster
        }))
      });
      
      if (lobby.currentPick >= lobby.draftOrder.length) {
        endDraft(lobby);
      } else {
        io.to(lobby.id).emit('nextPick', {
          currentPick: lobby.currentPick,
          currentDrafter: lobby.draftOrder[lobby.currentPick],
          timePerPick: timePerPick
        });
        startDraftTimer(lobby);
      }
    } else {
      console.log(`Lobby ${lobby.id}: player pool exhausted or drafter missing, ending draft early`);
      endDraft(lobby);
    }
  }, timePerPick * 1000);
}

function endDraft(lobby) {
  lobby.state = 'live';
  
  if (lobby.draftTimer) {
    clearTimeout(lobby.draftTimer);
    lobby.draftTimer = null;
  }
  
  io.to(lobby.id).emit('draftComplete', {
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      roster: p.roster,
      totalScore: 0
    }))
  });
  
  lobby.scoreInterval = setInterval(() => {
    updateLiveScores(lobby.id);
  }, SCORE_UPDATE_INTERVAL);
  
  updateLiveScores(lobby.id);
  console.log(`Draft complete in lobby ${lobby.id}, live scoring started`);
}

// ============================================
// HELPERS
// ============================================
function getLobbyState(lobby) {
  return {
    id: lobby.id,
    hostName: lobby.hostName,
    maxPlayers: lobby.maxPlayers,
    isPublic: lobby.isPublic,
    state: lobby.state,
    settings: lobby.settings,
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      roster: p.roster,
      totalScore: p.totalScore,
      disconnected: p.disconnected || false
    }))
  };
}

// ============================================
// REST API ROUTES
// ============================================
app.get('/api/lobbies', (req, res) => {
  const available = publicLobbies
    .map(id => lobbies[id])
    .filter(l => l && l.state === 'waiting' && l.players.length < l.maxPlayers)
    .map(l => ({
      id: l.id,
      hostName: l.hostName,
      players: l.players.length,
      maxPlayers: l.maxPlayers
    }));
  res.json(available);
});

app.get('/api/games', async (req, res) => {
  const targetDate = req.query.date || null;
  const [nbaGames, nhlGames] = await Promise.all([
    fetchNBAGames(targetDate),
    fetchNHLGames(targetDate)
  ]);
  res.json([...nbaGames, ...nhlGames]);
});

app.get('/api/scoring', (req, res) => {
  res.json(SCORING);
});

app.get('/api/gamelog/:league/:athleteId', async (req, res) => {
  const { league, athleteId } = req.params;
  try {
    let games;
    if (league === 'nba') {
      games = await fetchNBAGameLog(athleteId);
    } else if (league === 'nhl') {
      games = await fetchNHLGameLog(athleteId);
    } else {
      return res.status(400).json({ error: 'Invalid league' });
    }
    res.json({ games, league });
  } catch (e) {
    console.error(`Game log error for ${league}/${athleteId}:`, e.message);
    res.status(500).json({ error: 'Failed to fetch game log' });
  }
});

// Cache stats endpoint — for debugging/monitoring
app.get('/api/cache-stats', (req, res) => {
  res.json({
    nhlPlayerStats: nhlPlayerStatsCache.size,
    nbaPlayerStats: nbaPlayerStatsCache.size,
    schedule: scheduleCache.size,
    gameLog: gameLogCache.size,
    boxscore: boxscoreCache.size,
    nhlRoster: nhlRosterCache.size,
    nbaRoster: nbaRosterCache.size,
    activeLobbies: Object.keys(lobbies).length,
    activeSessions: Object.keys(sessions).length
  });
});

// ============================================
// CLEANUP - Remove stale lobbies every 5 minutes
// ============================================
setInterval(() => {
  const now = Date.now();
  const staleTime = 4 * 60 * 60 * 1000;
  const finishedTime = 30 * 60 * 1000;
  
  for (const [id, lobby] of Object.entries(lobbies)) {
    const isOld = now - lobby.createdAt > staleTime;
    const isFinishedOld = lobby.state === 'finished' && now - lobby.createdAt > finishedTime;
    const allDisconnected = lobby.state !== 'waiting' && lobby.players.every(p => p.disconnected);

    if (isOld || isFinishedOld || allDisconnected) {
      if (lobby.scoreInterval) clearInterval(lobby.scoreInterval);
      if (lobby.draftTimer) clearTimeout(lobby.draftTimer);
      for (const p of lobby.players) {
        delete sessions[p.id];
      }
      delete lobbies[id];
      const idx = publicLobbies.indexOf(id);
      if (idx !== -1) publicLobbies.splice(idx, 1);
      console.log(`Cleaned up lobby ${id} (${isOld?'stale':isFinishedOld?'finished':'all disconnected'})`);
    }
  }

  // Prune old cache entries periodically
  const pruneCacheTTL = (cache, ttl) => {
    for (const [key, entry] of cache) {
      if (now - entry.timestamp > ttl) cache.delete(key);
    }
  };
  pruneCacheTTL(nhlPlayerStatsCache, NHL_STATS_CACHE_TTL * 2);
  pruneCacheTTL(nbaPlayerStatsCache, NBA_STATS_CACHE_TTL * 2);
  pruneCacheTTL(scheduleCache, SCHEDULE_CACHE_TTL * 3);
  pruneCacheTTL(gameLogCache, GAMELOG_CACHE_TTL * 2);
  pruneCacheTTL(boxscoreCache, BOXSCORE_CACHE_TTL * 3);
  pruneCacheTTL(nhlRosterCache, NHL_ROSTER_CACHE_TTL * 2);
  pruneCacheTTL(nbaRosterCache, NBA_ROSTER_CACHE_TTL * 2);
}, 5 * 60 * 1000);

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Draft Royale running on port ${PORT}`);
});
