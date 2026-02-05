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
      // Reverse for odd rounds in snake draft
      for (let i = numPlayers - 1; i >= 0; i--) {
        order.push(players[i].id);
      }
    } else {
      // Forward (always for linear, even rounds for snake)
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
  try {
    let dateStr;
    if (targetDate) {
      // Parse ISO date string directly to avoid timezone shift
      // "2026-02-05" -> "20260205"
      const parts = targetDate.split('-');
      dateStr = parts.join('');
    } else {
      const d = new Date();
      dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`);
    const data = await response.json();
    
    return (data.events || []).map(event => {
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
  } catch (err) {
    console.error('Error fetching NBA games:', err);
    return [];
  }
}

async function fetchNHLGames(targetDate) {
  try {
    let dateStr;
    if (targetDate) {
      // Use ISO date string directly to avoid timezone shift
      // "2026-02-05" stays "2026-02-05"
      dateStr = targetDate;
    } else {
      const d = new Date();
      dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const response = await fetch(`https://api-web.nhle.com/v1/schedule/${dateStr}`);
    if (!response.ok) {
      console.error(`NHL schedule API returned ${response.status} for ${dateStr}`);
      return [];
    }
    const data = await response.json();
    
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
    return games;
  } catch (err) {
    console.error('Error fetching NHL games:', err);
    return [];
  }
}

async function fetchNBAPlayersForGames(games) {
  const players = [];
  
  for (const game of games) {
    // Build list of teams in this game
    const teams = [
      { id: game.homeTeamId, abbrev: game.homeTeam, name: game.homeName },
      { id: game.awayTeamId, abbrev: game.awayTeam, name: game.awayName }
    ];
    
    let gotPlayers = false;
    
    // Primary approach: fetch team rosters via ESPN team roster endpoint
    // This works reliably for pre-game, in-progress, and completed games
    for (const team of teams) {
      if (!team.id) continue;
      try {
        const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.id}/roster`);
        const data = await response.json();
        
        for (const athlete of data.athletes || []) {
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
      } catch (teamErr) {
        console.error(`Error fetching NBA roster for team ${team.abbrev} (${team.id}):`, teamErr.message);
      }
    }
    
    // Fallback: if team roster endpoint didn't work, try summary endpoint
    // (works for in-progress/completed games that have rosters populated)
    if (!gotPlayers) {
      try {
        const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.gameId}`);
        const data = await response.json();
        
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
    try {
      // Use team roster endpoints instead of gamecenter (which doesn't have a roster path)
      // Fetch rosters for both teams in the game
      const teams = [
        { abbrev: game.homeTeam, name: game.homeName },
        { abbrev: game.awayTeam, name: game.awayName }
      ];
      
      for (const team of teams) {
        try {
          const response = await fetch(`https://api-web.nhle.com/v1/roster/${team.abbrev}/current`);
          if (!response.ok) {
            console.error(`NHL roster API returned ${response.status} for ${team.abbrev}`);
            continue;
          }
          const data = await response.json();
          
          for (const posGroup of ['forwards', 'defensemen', 'goalies']) {
            for (const player of (data[posGroup] || [])) {
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
        } catch (teamErr) {
          console.error(`Error fetching roster for ${team.abbrev}:`, teamErr.message);
        }
      }
    } catch (err) {
      console.error(`Error fetching NHL players for game ${game.gameId}:`, err);
    }
  }
  
  return players;
}

// Fetch season averages for NBA players in bulk (one call per athlete)
async function enrichNBAPlayerAverages(players) {
  const nbaPlayers = players.filter(p => p.league === 'nba');
  
  // Process in true sequential batches
  const BATCH_SIZE = 10;
  const BATCH_DELAY = 300;
  
  for (let i = 0; i < nbaPlayers.length; i += BATCH_SIZE) {
    const batch = nbaPlayers.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (player) => {
      try {
        const res = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${player.athleteId}/stats`);
        const data = await res.json();
        
        // ESPN v3 stats endpoint returns categories like:
        // { name: "averages", labels: ["GP","GS","MIN",...,"REB","AST","BLK","STL",...,"PTS"],
        //   statistics: [ { season: {year:2025}, stats: ["55","55","33.1",...] }, ... ] }
        // We need the most recent season's stats from the "averages" category.
        const categories = data.categories || [];
        const avgCat = categories.find(c => c.name === 'averages' || c.displayName?.includes('Average'));
        
        if (avgCat && avgCat.labels && avgCat.statistics && avgCat.statistics.length > 0) {
          const labels = avgCat.labels;
          // Get the most recent season (last entry in statistics array)
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
        
        // Fallback: try the older perGame category format (in case ESPN changes format)
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
        
        // Fallback: check splits
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
        
        // Recalculate projection
        const a = player.seasonAvg;
        player.projectedScore = Math.round(((a.points * SCORING.nba.points) + (a.rebounds * SCORING.nba.rebounds) +
          (a.assists * SCORING.nba.assists) + (a.steals * SCORING.nba.steals) + (a.blocks * SCORING.nba.blocks)) * 10) / 10;
      } catch (e) {
        // Silently fail - player keeps default 0 projections
      }
    }));
    
    // Wait between batches
    if (i + BATCH_SIZE < nbaPlayers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
}

// Fetch NHL player season stats
async function enrichNHLPlayerAverages(players) {
  const nhlPlayers = players.filter(p => p.league === 'nhl');
  
  // Process in true sequential batches to avoid NHL API rate limits
  const BATCH_SIZE = 8;
  const BATCH_DELAY = 500; // ms between batches
  
  for (let i = 0; i < nhlPlayers.length; i += BATCH_SIZE) {
    const batch = nhlPlayers.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (player) => {
      // Try up to 2 times per player
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`https://api-web.nhle.com/v1/player/${player.athleteId}/landing`);
          if (res.status === 429) {
            // Rate limited — wait and retry
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          if (!res.ok) break; // skip non-rate-limit errors
          const data = await res.json();
          
          // Get current season stats from featuredStats
          const reg = data.featuredStats?.regularSeason?.subSeason;
          if (reg) {
            const gp = reg.gamesPlayed || 1;
            if (player.isGoalie) {
              player.seasonAvg = {
                saves: Math.round((reg.saves || 0) / gp * 10) / 10,
                goalsAgainst: Math.round((reg.goalsAgainst || 0) / gp * 10) / 10
              };
              player.projectedScore = Math.round(((player.seasonAvg.saves * SCORING.nhl.saves)) * 10) / 10;
            } else {
              player.seasonAvg = {
                goals: Math.round((reg.goals || 0) / gp * 10) / 10,
                assists: Math.round((reg.assists || 0) / gp * 10) / 10,
                shotsOnGoal: Math.round((reg.shots || 0) / gp * 10) / 10,
                blockedShots: 0  // NHL API doesn't always include this in featured stats
              };
              const a = player.seasonAvg;
              player.projectedScore = Math.round(((a.goals * SCORING.nhl.goals) + (a.assists * SCORING.nhl.assists) +
                (a.shotsOnGoal * SCORING.nhl.shotsOnGoal)) * 10) / 10;
            }
          }
          break; // success, no more retries
        } catch (e) {
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 500));
          }
          // Silently fail on final attempt
        }
      }
    }));
    
    // Wait between batches to respect rate limits
    if (i + BATCH_SIZE < nhlPlayers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
}

// Assign tier badges based on projected fantasy score
function assignTierBadges(players) {
  // Separate by league for fair comparison
  const nbaPlayers = players.filter(p => p.league === 'nba');
  const nhlPlayers = players.filter(p => p.league === 'nhl');
  
  function assignTiers(list) {
    const sorted = [...list].sort((a, b) => (b.projectedScore || 0) - (a.projectedScore || 0));
    const total = sorted.length;
    sorted.forEach((p, i) => {
      const pct = i / total;
      if (pct < 0.1) { p.tier = 'star'; p.tierLabel = '⭐ Star'; }
      else if (pct < 0.3) { p.tier = 'starter'; p.tierLabel = '🟢 Starter'; }
      else if (pct < 0.6) { p.tier = 'solid'; p.tierLabel = '🔵 Solid'; }
      else { p.tier = 'bench'; p.tierLabel = '⚪ Bench'; }
      // Copy tier back to original player object
      const orig = list.find(op => op.id === p.id);
      if (orig) { orig.tier = p.tier; orig.tierLabel = p.tierLabel; }
    });
  }
  
  assignTiers(nbaPlayers);
  assignTiers(nhlPlayers);
}

// Game log cache - avoids redundant API calls when opening the same player modal
const gameLogCache = new Map(); // key: 'league-athleteId' -> { data, timestamp }
const GAMELOG_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedGameLog(league, athleteId) {
  const key = `${league}-${athleteId}`;
  const cached = gameLogCache.get(key);
  if (cached && Date.now() - cached.timestamp < GAMELOG_CACHE_TTL) {
    return cached.data;
  }
  gameLogCache.delete(key);
  return null;
}

function setCachedGameLog(league, athleteId, data) {
  gameLogCache.set(`${league}-${athleteId}`, { data, timestamp: Date.now() });
  // Prune cache if too large
  if (gameLogCache.size > 500) {
    const oldest = gameLogCache.keys().next().value;
    gameLogCache.delete(oldest);
  }
}

// Fetch last 3 game log for a player (called on-demand via API)
async function fetchNBAGameLog(athleteId) {
  // Check cache first
  const cached = getCachedGameLog('nba', athleteId);
  if (cached) return cached;

  const games = [];

  // Strategy 1: ESPN athlete statistics/splits endpoint
  // This is more reliable than the gamelog endpoint and includes recent game data
  try {
    const res = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${athleteId}/stats`);
    if (res.ok) {
      const data = await res.json();

      // Look for a "gameLog" or recent splits in the response
      // The stats endpoint sometimes includes splits with recent game data
      const categories = data.categories || [];

      // Try to find game log data within the stats response
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

  // Strategy 2: ESPN gamelog endpoint (the original approach, with better parsing)
  if (games.length === 0) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${athleteId}/gamelog`);
      if (res.ok) {
        const data = await res.json();

        let events = data.events || {};
        let labels = [];
        let statsByEvent = {};

        // Collect stats from all possible structures
        const allCategories = [];

        // Top-level categories
        if (data.categories) allCategories.push(...data.categories);

        // SeasonTypes nested categories
        if (data.seasonTypes) {
          for (const season of data.seasonTypes) {
            if (season.categories) allCategories.push(...season.categories);
            // Collect events metadata
            if (season.events) {
              for (const [eid, evtData] of Object.entries(season.events)) {
                if (!events[eid]) events[eid] = evtData;
              }
            }
          }
        }

        // Parse categories for stats
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

        // Get last 3 events with stats
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

  // Strategy 3: ESPN v2 scoreboard/event summary approach
  // Uses a different URL pattern that tends to be more stable
  if (games.length === 0) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${athleteId}`);
      if (res.ok) {
        const data = await res.json();
        // Some athlete pages include recent stats
        const stats = data.statistics;
        if (stats && stats.splits) {
          const lastGames = stats.splits.categories?.find(c => c.name === 'Last 5 Games' || c.name === 'Last 3 Games');
          if (lastGames && lastGames.stats) {
            for (const s of lastGames.stats) {
              games.push({
                date: '?',
                opponent: '?',
                stats: {
                  points: parseFloat(s.value) || 0,
                  rebounds: 0, assists: 0, steals: 0, blocks: 0, minutes: '0'
                }
              });
            }
          }
        }
      }
    } catch (e) {
      // silently fail
    }
  }

  setCachedGameLog('nba', athleteId, games);
  return games;
}

// Helper to format opponent string from ESPN event data
function formatOpponent(evt) {
  if (!evt || !evt.opponent) return '?';
  const prefix = evt.atVs === '@' || evt.homeAway === 'away' ? '@' : 'vs';
  return `${prefix} ${evt.opponent.abbreviation || evt.opponent.displayName || '?'}`;
}

async function fetchNHLGameLog(playerId) {
  // Check cache first
  const cached = getCachedGameLog('nhl', playerId);
  if (cached) return cached;

  try {
    const res = await fetch(`https://api-web.nhle.com/v1/player/${playerId}/game-log/now`);
    if (!res.ok) {
      console.error(`NHL game log API returned ${res.status} for player ${playerId}`);
      return [];
    }
    const data = await res.json();
    
    const gameLog = data.gameLog || [];
    const last3 = gameLog.slice(0, 3); // NHL API returns most recent first
    
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
        // Goalie
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
  try {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`);
    const data = await response.json();
    
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
    
    return playerStats;
  } catch (err) {
    console.error(`Error fetching NBA stats for ${gameId}:`, err);
    return {};
  }
}

async function fetchLiveNHLStats(gameId) {
  try {
    const response = await fetch(`https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`);
    if (!response.ok) {
      console.error(`NHL boxscore API returned ${response.status} for game ${gameId}`);
      return {};
    }
    const data = await response.json();
    
    const playerStats = {};
    
    for (const side of ['homeTeam', 'awayTeam']) {
      // Forwards and defensemen
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
      
      // Goalies
      for (const player of (data[side]?.goalies || [])) {
        playerStats[`nhl-${player.playerId}`] = {
          saves: player.saveShotsAgainst ? 
            (parseInt(player.saveShotsAgainst.split('/')[0]) || 0) : 0,
          goalsAgainst: player.goalsAgainst || 0,
          isGoalie: true
        };
      }
    }
    
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
    
    // Double-double check (2+ categories with 10+)
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
  
  // Gather unique game IDs
  const nbaGameIds = new Set();
  const nhlGameIds = new Set();
  
  for (const player of lobby.players) {
    for (const pick of player.roster || []) {
      if (pick.league === 'nba') nbaGameIds.add(pick.gameId);
      if (pick.league === 'nhl') nhlGameIds.add(pick.gameId);
    }
  }
  
  // Fetch stats for all relevant games
  const allStats = {};
  
  for (const gameId of nbaGameIds) {
    const stats = await fetchLiveNBAStats(gameId);
    Object.assign(allStats, stats);
  }
  
  for (const gameId of nhlGameIds) {
    const stats = await fetchLiveNHLStats(gameId);
    Object.assign(allStats, stats);
  }
  
  // Update player stats and scores
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
  
  // Check if all games are finished (fetch schedule once per league, not per game)
  let allFinished = true;
  const hasNBA = lobby.games.some(g => g.league === 'nba');
  const hasNHL = lobby.games.some(g => g.league === 'nhl');
  const [nbaSchedule, nhlSchedule] = await Promise.all([
    hasNBA ? fetchNBAGames(lobby.gameDate) : Promise.resolve([]),
    hasNHL ? fetchNHLGames(lobby.gameDate) : Promise.resolve([])
  ]);

  // Now sync game status from schedule to individual picks for frontend display
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
      if (found) {
        game.state = found.state;
        game.status = found.status;
      }
      if (!found || found.state !== 'post') allFinished = false;
    }
    if (game.league === 'nhl') {
      const found = nhlSchedule.find(g => g.gameId === game.gameId);
      if (found) {
        game.state = found.state;
        game.status = found.status;
      }
      if (!found || (found.state !== 'OFF' && found.state !== 'FINAL')) allFinished = false;
    }
  }
  
  // If no games have started yet (future date draft), slow the polling
  const anyStarted = lobby.games.some(g =>
    (g.league === 'nba' && g.state !== 'pre') ||
    (g.league === 'nhl' && g.state !== 'FUT')
  );
  if (!anyStarted && !allFinished) {
    // Switch to slow polling (every 5 min) until games start
    if (lobby.scoreInterval && !lobby._slowPolling) {
      clearInterval(lobby.scoreInterval);
      lobby._slowPolling = true;
      lobby.scoreInterval = setInterval(() => updateLiveScores(lobbyId), 300000);
      console.log(`Lobby ${lobbyId}: games haven't started, slowing poll to 5min`);
    }
  } else if (anyStarted && lobby._slowPolling) {
    // Games started — switch back to fast polling
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
  
  // Emit updated scores to all players
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
  
  // Create a new lobby
  socket.on('createLobby', async ({ playerName, maxPlayers, isPublic, settings, sessionId }) => {
    // Prevent double-create: if this session is already in a lobby, ignore
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

  // Host updates lobby settings
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
  
  // Join existing lobby
  socket.on('joinLobby', ({ lobbyId, playerName, sessionId }) => {
    const code = lobbyId.toUpperCase();
    const safeName = sanitizeName(playerName);
    const lobby = lobbies[code];
    
    // Prevent joining if already in a lobby
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
    
    // Remove from public lobbies if full
    if (lobby.players.length >= lobby.maxPlayers) {
      const idx = publicLobbies.indexOf(code);
      if (idx !== -1) publicLobbies.splice(idx, 1);
    }
    
    io.to(code).emit('lobbyUpdate', getLobbyState(lobby));
    console.log(`${playerName} joined lobby ${code} (session ${sessionId})`);
  });
  
  // Rejoin after disconnect/refresh
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
    
    // Update mappings
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
      // Calculate remaining time on current pick
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
  
  // Find a public lobby
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
  
  // Host starts the draft
  socket.on('startDraft', async () => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;
    if (socket.sessionId !== lobby.host) return;
    if (lobby.state === 'drafting') return; // prevent double-start
    if (lobby.players.length < 1) {
      return socket.emit('error', { message: 'Need at least 1 player' });
    }
    
    lobby.state = 'drafting';
    const { draftType, timePerPick, leagues, gameDate } = lobby.settings;
    
    // Notify all clients that draft is loading
    io.to(lobby.id).emit('draftLoading', { message: 'Fetching games & players...' });
    
    // Fetch games for the target date based on league setting
    const fetchNBA = leagues === 'nba' || leagues === 'both';
    const fetchNHL = leagues === 'nhl' || leagues === 'both';
    
    const [nbaGames, nhlGames] = await Promise.all([
      fetchNBA ? fetchNBAGames(gameDate) : Promise.resolve([]),
      fetchNHL ? fetchNHLGames(gameDate) : Promise.resolve([])
    ]);
    
    // For future dates, all games are draftable.
    // For today, allow upcoming AND in-progress games (exclude only finished).
    const todayISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const isFutureDate = gameDate && gameDate !== todayISO;
    const upcomingNBA = isFutureDate ? nbaGames : nbaGames.filter(g => g.state !== 'post');
    const upcomingNHL = isFutureDate ? nhlGames : nhlGames.filter(g => g.state !== 'OFF' && g.state !== 'FINAL');
    
    // Store ALL games for live scoring later
    lobby.games = [...nbaGames, ...nhlGames];
    lobby.gameDate = gameDate; // remember which date we're tracking
    
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
    
    // Enrich players with season averages (runs in sequential batches)
    io.to(lobby.id).emit('draftLoading', { message: `Loading stats for ${nbaPlayers.length + nhlPlayers.length} players...` });
    console.log(`Enriching ${nbaPlayers.length} NBA + ${nhlPlayers.length} NHL players with season stats...`);
    await Promise.all([
      nbaPlayers.length > 0 ? enrichNBAPlayerAverages(lobby.availablePlayers) : Promise.resolve(),
      nhlPlayers.length > 0 ? enrichNHLPlayerAverages(lobby.availablePlayers) : Promise.resolve()
    ]);
    
    // Filter NBA players to top 6 per team (by projected score)
    // This keeps the draft pool focused on meaningful players and reduces API load
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
    
    // Assign tier badges based on projected score
    assignTierBadges(lobby.availablePlayers);
    
    // Sort by projected score descending (best players first)
    lobby.availablePlayers.sort((a, b) => (b.projectedScore || 0) - (a.projectedScore || 0));
    
    console.log(`Draft pool ready: ${upcomingNBA.length} NBA games (${filteredNba.length} players), ${upcomingNHL.length} NHL games (${nonNba.length} players) | Settings: ${draftType} draft, ${timePerPick}s/pick, leagues=${leagues}, slots=${JSON.stringify(lobby.settings.rosterSlots)}`);
    
    // Randomize player order then generate draft order
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
    
    // Start draft timer
    startDraftTimer(lobby);
    
    console.log(`Draft started in lobby ${lobby.id}`);
  });
  
  // Player makes a draft pick
  socket.on('draftPick', ({ playerId }) => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby || lobby.state !== 'drafting') return;
    
    // Check it's this player's turn
    const currentDrafter = lobby.draftOrder[lobby.currentPick];
    if (socket.sessionId !== currentDrafter) return;
    
    // Check player is available
    const playerIdx = lobby.availablePlayers.findIndex(p => p.id === playerId);
    if (playerIdx === -1) return;
    
    const picked = lobby.availablePlayers[playerIdx];
    const drafter = lobby.players.find(p => p.id === socket.sessionId);
    
    // Enforce league roster slots
    const slots = lobby.settings.rosterSlots || { nba: 10, nhl: 10 };
    const leagues = lobby.settings.leagues;
    if (leagues === 'both' || leagues === picked.league) {
      const leagueCount = (drafter.roster || []).filter(r => r.league === picked.league).length;
      const maxForLeague = slots[picked.league] || 0;
      if (leagueCount >= maxForLeague) {
        return socket.emit('error', { message: `${picked.league.toUpperCase()} roster full (${maxForLeague}/${maxForLeague})` });
      }
    }
    
    // Make the pick
    lobby.availablePlayers.splice(playerIdx, 1);
    drafter.roster.push(picked);
    
    // Clear timer
    if (lobby.draftTimer) {
      clearTimeout(lobby.draftTimer);
      lobby.draftTimer = null;
    }
    
    // Advance to next pick
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
    
    // Check if draft is complete
    if (lobby.currentPick >= lobby.draftOrder.length) {
      endDraft(lobby);
    } else {
      // Next pick
      io.to(lobby.id).emit('nextPick', {
        currentPick: lobby.currentPick,
        currentDrafter: lobby.draftOrder[lobby.currentPick],
        timePerPick: lobby.settings.timePerPick
      });
      startDraftTimer(lobby);
    }
  });
  
  // Chat message
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
  
  // Disconnect
  socket.on('disconnect', () => {
    const lobbyId = socket.lobbyId;
    const sessionId = socket.sessionId;
    if (!lobbyId || !lobbies[lobbyId]) return;
    
    const lobby = lobbies[lobbyId];
    
    if (lobby.state === 'waiting') {
      // Remove player from lobby
      lobby.players = lobby.players.filter(p => p.id !== sessionId);
      if (sessionId) delete sessions[sessionId];
      
      if (lobby.players.length === 0) {
        // Delete empty lobby
        delete lobbies[lobbyId];
        const idx = publicLobbies.indexOf(lobbyId);
        if (idx !== -1) publicLobbies.splice(idx, 1);
      } else {
        // Transfer host if needed
        if (lobby.host === sessionId) {
          lobby.host = lobby.players[0].id;
          lobby.players[0].isHost = true;
        }
        io.to(lobbyId).emit('lobbyUpdate', getLobbyState(lobby));
      }
    } else {
      // During draft/live, mark as disconnected but keep session for rejoin
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
  lobby.pickStartedAt = Date.now(); // track for reconnection
  lobby.draftTimer = setTimeout(() => {
    // Auto-pick: best available player that fits roster slots
    const currentDrafter = lobby.draftOrder[lobby.currentPick];
    const drafter = lobby.players.find(p => p.id === currentDrafter);
    
    if (lobby.availablePlayers.length > 0 && drafter) {
      const slots = lobby.settings.rosterSlots || { nba: 10, nhl: 10 };
      const nbaCount = (drafter.roster || []).filter(r => r.league === 'nba').length;
      const nhlCount = (drafter.roster || []).filter(r => r.league === 'nhl').length;
      
      // Find best available that fits a league slot
      let autoIdx = lobby.availablePlayers.findIndex(p => {
        if (p.league === 'nba' && nbaCount >= (slots.nba || 0)) return false;
        if (p.league === 'nhl' && nhlCount >= (slots.nhl || 0)) return false;
        return true;
      });
      if (autoIdx === -1) autoIdx = 0; // fallback
      
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
      // No players left or drafter not found — end draft early
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
  
  // Start live score updates
  lobby.scoreInterval = setInterval(() => {
    updateLiveScores(lobby.id);
  }, SCORE_UPDATE_INTERVAL);
  
  // Initial score fetch
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

// Get public lobbies
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

// Get today's games (for display)
app.get('/api/games', async (req, res) => {
  const targetDate = req.query.date || null; // ISO date string or null for today
  const [nbaGames, nhlGames] = await Promise.all([
    fetchNBAGames(targetDate),
    fetchNHLGames(targetDate)
  ]);
  
  res.json([...nbaGames, ...nhlGames]);
});

// Get scoring rules
app.get('/api/scoring', (req, res) => {
  res.json(SCORING);
});

// Get player game log (last 3 games) — with caching
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

// ============================================
// CLEANUP - Remove stale lobbies every 5 minutes
// ============================================
setInterval(() => {
  const now = Date.now();
  const staleTime = 4 * 60 * 60 * 1000; // 4 hours for active lobbies
  const finishedTime = 30 * 60 * 1000;   // 30 min for finished lobbies
  
  for (const [id, lobby] of Object.entries(lobbies)) {
    const isOld = now - lobby.createdAt > staleTime;
    const isFinishedOld = lobby.state === 'finished' && now - lobby.createdAt > finishedTime;
    const allDisconnected = lobby.state !== 'waiting' && lobby.players.every(p => p.disconnected);

    if (isOld || isFinishedOld || allDisconnected) {
      if (lobby.scoreInterval) clearInterval(lobby.scoreInterval);
      if (lobby.draftTimer) clearTimeout(lobby.draftTimer);
      // Clean up sessions for this lobby's players
      for (const p of lobby.players) {
        delete sessions[p.id];
      }
      delete lobbies[id];
      
      const idx = publicLobbies.indexOf(id);
      if (idx !== -1) publicLobbies.splice(idx, 1);
      
      console.log(`Cleaned up lobby ${id} (${isOld?'stale':isFinishedOld?'finished':'all disconnected'})`);
    }
  }
}, 5 * 60 * 1000);

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Draft Royale running on port ${PORT}`);
});
