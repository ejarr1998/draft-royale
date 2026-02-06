const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

// Firebase Admin SDK
const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : null;

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'draft-royale'
  });
  console.log('🔥 Firebase Admin initialized');
} else {
  console.warn('⚠️  Firebase service account not found - running without persistence');
}

const firestoreDb = serviceAccount ? admin.firestore() : null;

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
    goals: 9,           // Up from 5 (major impact)
    assists: 6,         // Up from 3 (major impact)
    shotsOnGoal: 3,     // Up from 1 (more aggressive play)
    blockedShots: 5,    // Up from 2 (defensive value)
    saves: 0.5,         // Same (goalies get many)
    shutout: 5,         // Same (bonus)
    hatTrick: 3         // Same (bonus)
  }
};

// ============================================
// ENHANCED CACHING SYSTEM
// ============================================
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'player-cache.json');
const CACHE_PERSIST_INTERVAL = 3 * 60 * 1000; // write to disk every 3 min
const CACHE_PERSIST_VERSION = 3; // bumped for new cache structure

// --- Persistent caches (survive restart) ---
// NHL player stats cache
const nhlPlayerStatsCache = new Map();
const NHL_STATS_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// NBA player stats cache
const nbaPlayerStatsCache = new Map();
const NBA_STATS_CACHE_TTL = 4 * 60 * 60 * 1000;

// NHL roster cache
const nhlRosterCache = new Map();
const NHL_ROSTER_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// NBA roster cache
const nbaRosterCache = new Map();
const NBA_ROSTER_CACHE_TTL = 6 * 60 * 60 * 1000;

// ⭐ ENRICHED PLAYER POOL CACHE — THE KEY OPTIMIZATION ⭐
// Stores fully enriched player pools by date+league, so multiple drafts reuse the same data
// Cache key format: "YYYY-MM-DD:league" (e.g., "2026-02-05:both", "2026-02-05:nba")
const enrichedPoolCache = new Map();
const ENRICHED_POOL_TTL = 6 * 60 * 60 * 1000; // 6 hours — enriched pools stay fresh for the day

// --- Ephemeral caches (NOT persisted — too short-lived) ---
// Schedule cache
const scheduleCache = new Map();
const SCHEDULE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// Live boxscore cache
const boxscoreCache = new Map();
const BOXSCORE_CACHE_TTL = 25 * 1000; // 25 seconds

// Registry of which caches to persist (name -> { cache, ttl })
const PERSISTENT_CACHES = {
  nhlPlayerStats:  { cache: nhlPlayerStatsCache, ttl: NHL_STATS_CACHE_TTL },
  nbaPlayerStats:  { cache: nbaPlayerStatsCache, ttl: NBA_STATS_CACHE_TTL },
  nhlRoster:       { cache: nhlRosterCache,      ttl: NHL_ROSTER_CACHE_TTL },
  nbaRoster:       { cache: nbaRosterCache,      ttl: NBA_ROSTER_CACHE_TTL },
  enrichedPool:    { cache: enrichedPoolCache,    ttl: ENRICHED_POOL_TTL },  // ⭐ NEW
};

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
  if (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// ⭐ Generate cache key for enriched player pools
function getEnrichedPoolKey(dateStr, leagues) {
  const date = dateStr || getTodayISO();
  return `${date}:${leagues || 'both'}`;
}

function getTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================
// DISK PERSISTENCE WITH IMMEDIATE SAVE OPTION
// ============================================
function saveCacheToDisk() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    const payload = { version: CACHE_PERSIST_VERSION, savedAt: Date.now(), caches: {} };

    for (const [name, { cache, ttl }] of Object.entries(PERSISTENT_CACHES)) {
      const entries = [];
      const now = Date.now();
      for (const [key, entry] of cache) {
        // Only persist entries that haven't expired yet
        if (now - entry.timestamp < ttl) {
          entries.push([key, entry]);
        }
      }
      payload.caches[name] = entries;
    }

    // Atomic write: write to temp file then rename
    const tmpFile = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    fs.renameSync(tmpFile, CACHE_FILE);

    const totalEntries = Object.values(payload.caches).reduce((s, c) => s + c.length, 0);
    const sizeKB = Math.round(fs.statSync(CACHE_FILE).size / 1024);
    console.log(`Cache persisted: ${totalEntries} entries, ${sizeKB}KB`);
  } catch (err) {
    console.error('Failed to persist cache:', err.message);
  }
}

// ⭐ Immediate save for critical data (enriched pools)
function saveEnrichedPoolImmediately() {
  try {
    saveCacheToDisk();
  } catch (err) {
    console.error('Failed to immediately persist enriched pool:', err.message);
  }
}

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      console.log('No cache file found — starting fresh');
      return;
    }

    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const payload = JSON.parse(raw);

    // Version check — discard incompatible caches
    if (payload.version !== CACHE_PERSIST_VERSION) {
      console.log(`Cache file version ${payload.version} doesn't match ${CACHE_PERSIST_VERSION} — discarding`);
      fs.unlinkSync(CACHE_FILE);
      return;
    }

    const now = Date.now();
    let loaded = 0, expired = 0;

    for (const [name, { cache, ttl }] of Object.entries(PERSISTENT_CACHES)) {
      const entries = payload.caches?.[name];
      if (!entries || !Array.isArray(entries)) continue;

      for (const [key, entry] of entries) {
        // Recheck TTL on load (time may have passed since save)
        if (entry && entry.timestamp && (now - entry.timestamp < ttl)) {
          cache.set(key, entry);
          loaded++;
        } else {
          expired++;
        }
      }
    }

    const age = Math.round((now - payload.savedAt) / 1000);
    console.log(`Cache restored: ${loaded} entries loaded, ${expired} expired (saved ${age}s ago)`);
    
    // Log enriched pool cache stats specifically
    if (enrichedPoolCache.size > 0) {
      console.log(`  → ${enrichedPoolCache.size} enriched player pools ready for reuse`);
    }
  } catch (err) {
    console.error('Failed to load cache from disk:', err.message);
    // Corrupt file — remove it so we don't fail every restart
    try { fs.unlinkSync(CACHE_FILE); } catch {}
  }
}

// Persist on clean shutdown
function setupGracefulShutdown() {
  const shutdown = (signal) => {
    console.log(`\n${signal} received — saving cache before exit...`);
    saveCacheToDisk();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Load cache immediately on module load
loadCacheFromDisk();
setupGracefulShutdown();

// Periodic save (in case of hard crash / kill -9)
setInterval(saveCacheToDisk, CACHE_PERSIST_INTERVAL);

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
            injuryStatus: athlete.injuries?.[0]?.status || null, // e.g., "Out", "Questionable", "Probable"
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
                  injuryStatus: athlete.injuries?.[0]?.status || null,
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

// ⭐⭐⭐ MASTER ENRICHED POOL FUNCTION ⭐⭐⭐
// This is the key function that caches entire enriched player pools
async function getOrBuildEnrichedPlayerPool(dateStr, leagues) {
  const cacheKey = getEnrichedPoolKey(dateStr, leagues);
  
  // Check cache first
  const cached = getCached(enrichedPoolCache, cacheKey, ENRICHED_POOL_TTL);
  if (cached) {
    console.log(`✅ Using cached enriched pool: ${cacheKey} (${cached.players.length} players)`);
    return cached;
  }

  console.log(`🔨 Building new enriched pool: ${cacheKey}...`);
  const startTime = Date.now();

  // Fetch games
  const fetchNBA = leagues === 'nba' || leagues === 'both';
  const fetchNHL = leagues === 'nhl' || leagues === 'both';
  
  const [nbaGames, nhlGames] = await Promise.all([
    fetchNBA ? fetchNBAGames(dateStr) : Promise.resolve([]),
    fetchNHL ? fetchNHLGames(dateStr) : Promise.resolve([])
  ]);
  
  const todayISO = getTodayISO();
  const isFutureDate = dateStr && dateStr !== todayISO;
  
  console.log(`📅 Building pool for date: ${dateStr || 'today'} (${dateStr || todayISO})`);
  console.log(`   isFutureDate: ${isFutureDate}`);
  console.log(`   NBA games fetched: ${nbaGames.length}, NHL games fetched: ${nhlGames.length}`);
  
  // ALWAYS filter to only games that haven't started yet
  // For today: Only include 'pre' / 'FUT' state games
  // For future dates: Include all games (since they won't have started yet)
  const upcomingNBA = nbaGames.filter(g => {
    // For future dates, include all games
    if (isFutureDate) return true;
    // For today/past, only include games that haven't started
    const include = g.state === 'pre';
    if (!include) console.log(`   ❌ Excluding NBA game: ${g.awayTeam} @ ${g.homeTeam} (state: ${g.state})`);
    return include;
  });
    
  const upcomingNHL = nhlGames.filter(g => {
    // For future dates, include all games
    if (isFutureDate) return true;
    // For today/past, only include games that haven't started
    const include = g.state === 'FUT' || g.state === 'PRE';
    if (!include) console.log(`   ❌ Excluding NHL game: ${g.awayTeam} @ ${g.homeTeam} (state: ${g.state})`);
    return include;
  });
  
  console.log(`   ✅ Games after filter: ${upcomingNBA.length} NBA, ${upcomingNHL.length} NHL`);
  
  const allGames = [...nbaGames, ...nhlGames];
  
  if (upcomingNBA.length === 0 && upcomingNHL.length === 0) {
    return { players: [], games: allGames, error: 'No games available' };
  }
  
  // Fetch players
  const [nbaPlayers, nhlPlayers] = await Promise.all([
    upcomingNBA.length > 0 ? fetchNBAPlayersForGames(upcomingNBA) : Promise.resolve([]),
    upcomingNHL.length > 0 ? fetchNHLPlayersForGames(upcomingNHL) : Promise.resolve([])
  ]);
  
  const allPlayers = [...nbaPlayers, ...nhlPlayers];
  
  if (allPlayers.length === 0) {
    return { players: [], games: allGames, error: 'No players available' };
  }
  
  // Enrich with stats
  await Promise.all([
    nbaPlayers.length > 0 ? enrichNBAPlayerAverages(allPlayers) : Promise.resolve(),
    nhlPlayers.length > 0 ? enrichNHLPlayerAverages(allPlayers) : Promise.resolve()
  ]);
  
  // Filter NBA players to top 6 per team
  const NBA_PLAYERS_PER_TEAM = 6;
  const nbaByTeamGame = {};
  const nonNba = [];
  for (const p of allPlayers) {
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
  const finalPlayers = [...filteredNba, ...nonNba];
  
  // Assign tiers and sort
  assignTierBadges(finalPlayers);
  finalPlayers.sort((a, b) => (b.projectedScore || 0) - (a.projectedScore || 0));
  
  const result = {
    players: finalPlayers,
    games: allGames,
    enrichedAt: Date.now()
  };
  
  // Cache the result
  setCache(enrichedPoolCache, cacheKey, result, 20); // Keep up to 20 different date+league combinations
  
  // ⭐ IMMEDIATELY persist to disk so other instances/restarts can use it
  saveEnrichedPoolImmediately();
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Built enriched pool ${cacheKey}: ${finalPlayers.length} players, ${upcomingNBA.length} NBA + ${upcomingNHL.length} NHL games (${elapsed}s)`);
  
  return result;
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
  if (cached) {
    console.log(`✅ Using cached NHL stats for ${gameId}: ${Object.keys(cached).length} players`);
    return cached;
  }

  try {
    console.log(`🏒 Fetching NHL boxscore for game ${gameId}...`);
    const data = await fetchWithRetry(
      `https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`,
      { label: `NHL boxscore ${gameId}`, maxRetries: 1 }
    );
    
    if (!data) {
      console.log(`❌ No data returned for NHL game ${gameId}`);
      return {};
    }
    
    console.log(`📦 NHL boxscore received for ${gameId}:`, {
      homeTeam: data.homeTeam ? 'present' : 'missing',
      awayTeam: data.awayTeam ? 'present' : 'missing',
      homeForwards: data.homeTeam?.forwards?.length || 0,
      awayForwards: data.awayTeam?.forwards?.length || 0,
      homeDefense: data.homeTeam?.defense?.length || 0,
      awayDefense: data.awayTeam?.defense?.length || 0,
      homeGoalies: data.homeTeam?.goalies?.length || 0,
      awayGoalies: data.awayTeam?.goalies?.length || 0
    });
    
    const playerStats = {};
    
    for (const side of ['homeTeam', 'awayTeam']) {
      for (const posGroup of ['forwards', 'defense']) {
        for (const player of (data[side]?.[posGroup] || [])) {
          const playerId = `nhl-${player.playerId}`;
          playerStats[playerId] = {
            goals: player.goals || 0,
            assists: player.assists || 0,
            shotsOnGoal: player.sog || 0,
            blockedShots: player.blockedShots || 0
          };
          console.log(`   ${playerId}: ${player.goals}G ${player.assists}A ${player.sog}SOG`);
        }
      }
      
      for (const player of (data[side]?.goalies || [])) {
        const playerId = `nhl-${player.playerId}`;
        playerStats[playerId] = {
          saves: player.saveShotsAgainst ? 
            (parseInt(player.saveShotsAgainst.split('/')[0]) || 0) : 0,
          goalsAgainst: player.goalsAgainst || 0,
          isGoalie: true
        };
        console.log(`   ${playerId} (G): ${playerStats[playerId].saves} saves, ${playerStats[playerId].goalsAgainst} GA`);
      }
    }

    console.log(`✅ Parsed ${Object.keys(playerStats).length} NHL players from game ${gameId}`);
    setCache(boxscoreCache, cacheKey, playerStats, 200);
    return playerStats;
  } catch (err) {
    console.error(`❌ Error fetching NHL stats for ${gameId}:`, err.message);
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
  try {
    const lobby = lobbies[lobbyId];
    console.log(`⏰ updateLiveScores called for lobby ${lobbyId}:`, {
      exists: !!lobby,
      state: lobby?.state,
      playerCount: lobby?.players.length
    });
    
    if (!lobby || lobby.state !== 'live') {
      console.warn(`❌ Skipping score update: ${!lobby ? 'lobby not found' : `state is ${lobby.state}`}`);
      return;
    }
  
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
    console.log(`\n🎮 Calculating score for ${player.name}:`);
    
    for (const pick of player.roster || []) {
      const hadStats = !!pick.stats;
      
      if (allStats[pick.id]) {
        pick.stats = allStats[pick.id];
        pick.isGoalie = pick.isGoalie || allStats[pick.id].isGoalie;
      }
      
      pick.fantasyScore = calculateFantasyScore(pick);
      totalScore += pick.fantasyScore;
      
      if (pick.league === 'nhl') {
        console.log(`   ${pick.league.toUpperCase()} ${pick.name} (${pick.id}):`, {
          foundStats: !!allStats[pick.id],
          hadStats,
          stats: pick.stats,
          fantasyScore: pick.fantasyScore
        });
      }
    }
    player.totalScore = Math.round(totalScore * 10) / 10;
    console.log(`   ✅ Total: ${player.totalScore} pts`);
  }
  
  // Check game states (use schedule cache — at most 1 fetch per league per 2 min)
  let allFinished = true;
  const hasNBA = lobby.games.some(g => g.league === 'nba');
  const hasNHL = lobby.games.some(g => g.league === 'nhl');
  
  console.log(`\n🏁 Checking if games finished:`, {
    hasNBA,
    hasNHL,
    totalGames: lobby.games.length
  });
  
  const [nbaSchedule, nhlSchedule] = await Promise.all([
    hasNBA ? fetchNBAGames(lobby.gameDate) : Promise.resolve([]),
    hasNHL ? fetchNHLGames(lobby.gameDate) : Promise.resolve([])
  ]);
  
  console.log(`   Fetched schedules: ${nbaSchedule.length} NBA, ${nhlSchedule.length} NHL`);
  
  // If we expected schedules but got nothing, something's wrong - don't end game
  if ((hasNBA && nbaSchedule.length === 0) || (hasNHL && nhlSchedule.length === 0)) {
    console.log(`⚠️  WARNING: Expected schedules but got empty arrays - keeping game alive`);
    allFinished = false;
  }

  // Helper to format game status for display
  function formatGameStatus(game) {
    const state = game.state || game.status;
    const startTime = game.startTime;
    
    // Live states
    if (state && (state.includes('LIVE') || state.includes('Period') || state.includes('Quarter') || 
        state.includes('Q1') || state.includes('Q2') || state.includes('Q3') || state.includes('Q4') ||
        state.includes('1st') || state.includes('2nd') || state.includes('3rd') || state.includes('Halftime'))) {
      return state;
    }
    
    // Final states
    if (state === 'post' || state === 'OFF' || state === 'FINAL' || state.includes('Final')) {
      return 'Final';
    }
    
    // Future games - show time
    if (state === 'pre' || state === 'FUT' || !state) {
      if (startTime) {
        const gameTime = new Date(startTime);
        const now = new Date();
        const diffHours = (gameTime - now) / (1000 * 60 * 60);
        
        // If game is today, show time
        if (diffHours > -24 && diffHours < 24) {
          return gameTime.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit', 
            hour12: true,
            timeZone: 'America/New_York'  // ET for consistency
          });
        }
      }
      return 'Scheduled';
    }
    
    return state || 'Scheduled';
  }

  const gameStatusMap = {};
  const gameDataMap = {}; // Store full game data for time info
  
  for (const g of nbaSchedule) {
    gameStatusMap[g.gameId] = formatGameStatus(g);
    gameDataMap[g.gameId] = g;
  }
  for (const g of nhlSchedule) {
    gameStatusMap[g.gameId] = formatGameStatus(g);
    gameDataMap[g.gameId] = g;
  }
  
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
        console.log(`   NBA ${game.awayTeam} @ ${game.homeTeam}: ${found.state}`);
      } else {
        console.log(`   ⚠️  NBA game ${game.gameId} not found in schedule`);
      }
      if (!found || found.state !== 'post') allFinished = false;
    }
    if (game.league === 'nhl') {
      const found = nhlSchedule.find(g => g.gameId === game.gameId);
      if (found) { 
        game.state = found.state; 
        game.status = found.status; 
        console.log(`   NHL ${game.awayTeam} @ ${game.homeTeam}: ${found.state}`);
      } else {
        console.log(`   ⚠️  NHL game ${game.gameId} not found in schedule`);
      }
      if (!found || (found.state !== 'OFF' && found.state !== 'FINAL')) allFinished = false;
    }
  }
  
  console.log(`   📊 All games finished? ${allFinished}`);
  
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
    console.log(`🏁 Lobby ${lobbyId}: All games finished`);
  }
  
  console.log(`📊 Broadcasting scoreUpdate to lobby ${lobbyId}:`, {
    playerCount: lobby.players.length,
    state: lobby.state,
    scores: lobby.players.map(p => ({ name: p.name, score: p.totalScore }))
  });
  
  io.to(lobbyId).emit('scoreUpdate', {
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      roster: p.roster,
      totalScore: p.totalScore
    })),
    state: lobby.state
  });
  
  // Save updated scores to Firestore (throttled - only every 5 updates)
  if (!lobby._firestoreSaveCount) lobby._firestoreSaveCount = 0;
  lobby._firestoreSaveCount++;
  
  if (lobby._firestoreSaveCount >= 5 || lobby.state === 'finished') {
    saveLobbyToFirestore(lobby);
    lobby._firestoreSaveCount = 0;
  }
  
  } catch (err) {
    console.error(`❌ ERROR in updateLiveScores for lobby ${lobbyId}:`, err.message);
    console.error(err.stack);
    // Don't end the game on error - keep it alive
  }
}

// ⭐ CACHE WARMUP — Pre-fetch today's enriched pool on startup
async function warmupCache() {
  console.log('🔥 Warming up cache with today\'s games...');
  try {
    const todayISO = getTodayISO();
    await getOrBuildEnrichedPlayerPool(todayISO, 'both');
    console.log('✅ Cache warmup complete');
  } catch (err) {
    console.error('❌ Cache warmup failed:', err.message);
  }
}

// ============================================
// PERSONALIZED PLAYER POOL
// ============================================
// Filters out players from leagues where the drafter's roster is full
function sendPersonalizedPlayerPool(lobby, drafterId) {
  const drafter = lobby.players.find(p => p.id === drafterId);
  if (!drafter) return;
  
  const session = sessions[drafterId];
  if (!session || !session.socketId) return;
  
  const slots = lobby.settings.rosterSlots || { nba: 10, nhl: 10 };
  const nbaCount = (drafter.roster || []).filter(r => r.league === 'nba').length;
  const nhlCount = (drafter.roster || []).filter(r => r.league === 'nhl').length;
  
  const nbaFull = nbaCount >= (slots.nba || 0);
  const nhlFull = nhlCount >= (slots.nhl || 0);
  
  // Filter out players from full leagues
  let filteredPlayers = lobby.availablePlayers;
  if (nbaFull || nhlFull) {
    filteredPlayers = lobby.availablePlayers.filter(p => {
      if (p.league === 'nba' && nbaFull) return false;
      if (p.league === 'nhl' && nhlFull) return false;
      return true;
    });
  }
  
  // Send personalized pool to this specific drafter
  io.to(session.socketId).emit('personalizedPlayerPool', {
    availablePlayers: filteredPlayers,
    fullLeagues: { nba: nbaFull, nhl: nhlFull }
  });
}

// ============================================
// FIRESTORE PERSISTENCE HELPERS
// ============================================
async function saveLobbyToFirestore(lobby) {
  if (!firestoreDb) return;
  
  try {
    await firestoreDb.collection('lobbies').doc(lobby.id).set({
      ...lobby,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error(`Error saving lobby ${lobby.id} to Firestore:`, err);
  }
}

async function deleteLobbyFromFirestore(lobbyId) {
  if (!firestoreDb) return;
  
  try {
    await firestoreDb.collection('lobbies').doc(lobbyId).delete();
    console.log(`🗑️  Deleted lobby ${lobbyId} from Firestore`);
  } catch (err) {
    console.error(`Error deleting lobby ${lobbyId}:`, err);
  }
}

// ============================================
// SOCKET.IO - REAL-TIME COMMUNICATION
// ============================================
function sanitizeName(name) {
  return String(name || 'Player').replace(/[<>"'&]/g, '').trim().slice(0, 20) || 'Player';
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Firebase Authentication Handler
  socket.on('authenticate', async ({ uid, displayName, photoURL }) => {
    if (!uid) {
      console.warn(`❌ No UID provided by ${socket.id}`);
      return socket.emit('authError', { message: 'Authentication required' });
    }
    
    console.log(`🔐 User authenticated: ${uid} (${displayName})`);
    
    socket.uid = uid;
    socket.displayName = displayName;
    socket.photoURL = photoURL;
    
    // Create/update session with UID
    sessions[uid] = {
      socketId: socket.id,
      uid,
      displayName,
      photoURL,
      lobbyId: sessions[uid]?.lobbyId || null
    };
    
    // If user was in a lobby, rejoin
    if (sessions[uid].lobbyId) {
      const lobby = lobbies[sessions[uid].lobbyId];
      if (lobby) {
        socket.join(lobby.id);
        socket.lobbyId = lobby.id;
        console.log(`🔄 User ${uid} rejoined lobby ${lobby.id}`);
      }
    }
    
    socket.emit('authenticated', { uid, displayName });
  });
  
  socket.on('createLobby', async ({ playerName, maxPlayers, isPublic, settings, sessionId }) => {
    // Support both UID (new) and sessionId (old) during migration
    const userId = socket.uid || sessionId;
    
    if (!userId) {
      return socket.emit('error', { message: 'Please sign in first' });
    }
    
    if (sessions[userId] && lobbies[sessions[userId].lobbyId]) {
      return socket.emit('error', { message: 'You are already in a game' });
    }
    
    const safeName = sanitizeName(playerName);
    const lobby = createLobby(safeName, maxPlayers, isPublic, settings || {});
    
    const player = {
      id: userId,  // Use UID instead of sessionId
      uid: socket.uid || null,  // Store UID separately
      name: safeName,
      photoURL: socket.photoURL || null,
      roster: [],
      totalScore: 0,
      isHost: true
    };
    
    lobby.players.push(player);
    lobby.host = userId;
    
    socket.join(lobby.id);
    socket.lobbyId = lobby.id;
    socket.sessionId = sessionId || userId;  // Backwards compat
    
    sessions[userId] = { 
      lobbyId: lobby.id, 
      socketId: socket.id, 
      playerName: safeName,
      uid: socket.uid,
      displayName: socket.displayName
    };
    
    // Save lobby to Firestore (non-blocking)
    if (firestoreDb) {
      firestoreDb.collection('lobbies').doc(lobby.id).set({
        ...lobby,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }).then(() => {
        console.log(`💾 Lobby ${lobby.id} saved to Firestore`);
        
        // Add to user's active games
        if (socket.uid) {
          return firestoreDb.collection('users').doc(socket.uid).update({
            activeGames: admin.firestore.FieldValue.arrayUnion(lobby.id)
          });
        }
      }).catch(err => {
        console.error('Error saving lobby to Firestore:', err);
      });
    }
    
    socket.emit('lobbyCreated', {
      lobbyId: lobby.id,
      lobby: getLobbyState(lobby)
    });
    
    console.log(`Lobby ${lobby.id} created by ${playerName} (${socket.uid ? 'uid: ' + socket.uid : 'session: ' + sessionId})`);
  });

  socket.on('updateSettings', ({ settings }) => {
    const lobby = lobbies[socket.lobbyId];
    console.log('📥 Received updateSettings:', {
      lobbyId: socket.lobbyId,
      settings,
      hasLobby: !!lobby,
      isHost: lobby ? socket.sessionId === lobby.host : false,
      lobbyState: lobby?.state
    });
    
    if (!lobby || socket.sessionId !== lobby.host || lobby.state !== 'waiting') {
      console.warn('❌ updateSettings rejected:', {
        noLobby: !lobby,
        notHost: lobby && socket.sessionId !== lobby.host,
        notWaiting: lobby && lobby.state !== 'waiting'
      });
      return;
    }
    
    if (settings.maxPlayers !== undefined) {
      lobby.maxPlayers = Math.min(Math.max(settings.maxPlayers, 1), 8);
    }
    if (settings.isPublic !== undefined) {
      lobby.isPublic = settings.isPublic;
      const idx = publicLobbies.indexOf(lobby.id);
      if (settings.isPublic && idx === -1) {
        publicLobbies.push(lobby.id);
        console.log(`✅ Lobby ${lobby.id} is now PUBLIC (total: ${publicLobbies.length})`);
        console.log('📋 Public lobbies:', publicLobbies);
      }
      if (!settings.isPublic && idx !== -1) {
        publicLobbies.splice(idx, 1);
        console.log(`✅ Lobby ${lobby.id} is now PRIVATE (total: ${publicLobbies.length})`);
      }
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
  
  socket.on('rejoin', async ({ sessionId, uid }) => {
    // Support both UID (new) and sessionId (old)
    const userId = uid || socket.uid || sessionId;
    
    if (!userId) {
      return socket.emit('rejoinFailed', { reason: 'no_auth' });
    }
    
    // If Firebase UID is provided, try loading from Firestore first
    if (uid && firestoreDb) {
      try {
        const userDoc = await firestoreDb.collection('users').doc(uid).get();
        const activeGameIds = userDoc.data()?.activeGames || [];
        
        // Try to restore lobby from Firestore
        for (const lobbyId of activeGameIds) {
          const lobbyDoc = await firestoreDb.collection('lobbies').doc(lobbyId).get();
          if (lobbyDoc.exists) {
            const lobbyData = lobbyDoc.data();
            
            // Restore lobby to memory if not there
            if (!lobbies[lobbyId]) {
              lobbies[lobbyId] = lobbyData;
              console.log(`🔄 Restored lobby ${lobbyId} from Firestore`);
            }
          }
        }
      } catch (err) {
        console.error('Error loading from Firestore:', err);
      }
    }
    
    const session = sessions[userId];
    if (!session) {
      return socket.emit('rejoinFailed', { reason: 'no_session' });
    }
    
    const lobby = lobbies[session.lobbyId];
    if (!lobby) {
      delete sessions[userId];
      return socket.emit('rejoinFailed', { reason: 'lobby_gone' });
    }
    
    const player = lobby.players.find(p => p.id === userId || p.uid === uid);
    if (!player) {
      delete sessions[userId];
      return socket.emit('rejoinFailed', { reason: 'player_gone' });
    }
    
    session.socketId = socket.id;
    socket.lobbyId = lobby.id;
    socket.sessionId = sessionId || userId;
    socket.uid = uid || socket.uid;
    player.disconnected = false;
    
    socket.join(lobby.id);
    
    const lobbyStateData = getLobbyState(lobby);
    const playerIsHost = lobby.host === userId || lobby.host === uid;
    
    console.log(`🔄 Player ${player.name} rejoined lobby ${lobby.id} (${uid ? 'uid: ' + uid : 'session: ' + userId})`);
    
    if (lobby.state === 'waiting') {
      socket.emit('rejoinState', {
        phase: 'waiting',
        lobby: lobbyStateData,
        isHost: playerIsHost,
        sessionId: userId
      });
    } else if (lobby.state === 'drafting') {
      const elapsed = lobby.pickStartedAt ? Math.floor((Date.now() - lobby.pickStartedAt) / 1000) : 0;
      const timeRemaining = Math.max((lobby.settings.timePerPick || 30) - elapsed, 1);
      
      socket.emit('rejoinState', {
        phase: 'drafting',
        lobby: lobbyStateData,
        isHost: playerIsHost,
        sessionId: userId,
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
      
      // Send personalized pool if it's their turn or will be soon
      sendPersonalizedPlayerPool(lobby, userId);
    } else {
      console.log(`📥 Rejoining ${player.name} to ${lobby.state} game in lobby ${lobby.id}`);
      socket.emit('rejoinState', {
        phase: lobby.state,
        lobby: lobbyStateData,
        isHost: playerIsHost,
        sessionId: userId,
        players: lobby.players.map(p => ({
          id: p.id, name: p.name, roster: p.roster, totalScore: p.totalScore
        }))
      });
      console.log(`✅ Sent rejoinState for ${lobby.state} phase with ${lobby.players.length} players`);
    }
    
    io.to(lobby.id).emit('playerReconnected', { playerName: player.name });
    console.log(`${player.name} rejoined lobby ${lobby.id} (session ${sessionId})`);
  });
  
  socket.on('findPublicLobby', ({ playerName }) => {
    console.log('🔍 Finding public lobby...');
    console.log('📋 Public lobbies array:', publicLobbies);
    console.log('📊 Total public lobbies:', publicLobbies.length);
    
    let found = null;
    for (const lobbyId of publicLobbies) {
      const lobby = lobbies[lobbyId];
      console.log(`  Checking lobby ${lobbyId}:`, {
        exists: !!lobby,
        state: lobby?.state,
        players: lobby?.players.length,
        maxPlayers: lobby?.maxPlayers,
        isPublic: lobby?.isPublic
      });
      
      if (lobby && lobby.state === 'waiting' && lobby.players.length < lobby.maxPlayers) {
        found = lobbyId;
        console.log(`✅ Found joinable public lobby: ${lobbyId}`);
        break;
      }
    }
    
    if (found) {
      console.log(`✅ Sending lobby ${found} to player`);
      socket.emit('publicLobbyFound', { lobbyId: found });
    } else {
      console.log('❌ No joinable public lobbies found');
      socket.emit('error', { message: 'No public lobbies available. Create one!' });
    }
  });
  
  socket.on('startDraft', async ({ settings }) => {
    const lobby = lobbies[socket.lobbyId];
    if (!lobby) return;
    if (socket.sessionId !== lobby.host) return;
    if (lobby.state === 'drafting') return;
    if (lobby.players.length < 1) {
      return socket.emit('error', { message: 'Need at least 1 player' });
    }
    
    // ⭐ APPLY SETTINGS FROM CLIENT ⭐
    if (settings) {
      lobby.settings = {
        draftType: settings.draftType || 'snake',
        timePerPick: Math.min(120, Math.max(10, settings.timePerPick || 30)),
        rosterSlots: {
          nba: Math.min(10, Math.max(0, settings.rosterSlots?.nba || 4)),
          nhl: Math.min(10, Math.max(0, settings.rosterSlots?.nhl || 2))
        },
        leagues: settings.leagues || 'both',
        gameDate: settings.gameDate || null
      };
      // Also update lobby-level properties
      if (settings.maxPlayers !== undefined) {
        lobby.maxPlayers = Math.min(8, Math.max(1, settings.maxPlayers));
      }
      if (settings.isPublic !== undefined) {
        lobby.isPublic = settings.isPublic;
        const idx = publicLobbies.indexOf(lobby.id);
        if (settings.isPublic && idx === -1) {
          publicLobbies.push(lobby.id);
        }
        if (!settings.isPublic && idx !== -1) {
          publicLobbies.splice(idx, 1);
        }
      }
    }
    
    lobby.state = 'drafting';
    const { draftType, timePerPick, leagues, gameDate } = lobby.settings;
    
    io.to(lobby.id).emit('draftLoading', { message: 'Fetching games & players...' });
    
    // ⭐⭐⭐ USE THE CACHED ENRICHED POOL ⭐⭐⭐
    const enrichedPool = await getOrBuildEnrichedPlayerPool(gameDate, leagues);
    
    if (enrichedPool.error || enrichedPool.players.length === 0) {
      lobby.state = 'waiting';
      const dateLabel = gameDate ? ` on ${new Date(gameDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
      io.to(lobby.id).emit('draftLoadingDone');
      return socket.emit('error', { message: enrichedPool.error || `No players available to draft${dateLabel}!` });
    }
    
    // Validate that selected leagues have games
    const nbaGames = enrichedPool.games.filter(g => g.league === 'nba');
    const nhlGames = enrichedPool.games.filter(g => g.league === 'nhl');
    
    if (leagues === 'nba' && nbaGames.length === 0) {
      lobby.state = 'waiting';
      const dateLabel = gameDate ? ` on ${new Date(gameDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
      io.to(lobby.id).emit('draftLoadingDone');
      return socket.emit('error', { message: `No NBA games available${dateLabel}. Choose a different date or league.` });
    }
    
    if (leagues === 'nhl' && nhlGames.length === 0) {
      lobby.state = 'waiting';
      const dateLabel = gameDate ? ` on ${new Date(gameDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
      io.to(lobby.id).emit('draftLoadingDone');
      return socket.emit('error', { message: `No NHL games available${dateLabel}. Choose a different date or league.` });
    }
    
    if (leagues === 'both' && (nbaGames.length === 0 || nhlGames.length === 0)) {
      lobby.state = 'waiting';
      const missingLeague = nbaGames.length === 0 ? 'NBA' : 'NHL';
      const dateLabel = gameDate ? ` on ${new Date(gameDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
      io.to(lobby.id).emit('draftLoadingDone');
      return socket.emit('error', { message: `No ${missingLeague} games available${dateLabel}. Select single league or choose different date.` });
    }
    
    // Deep clone the enriched pool players so each lobby gets its own copy
    // (prevents multiple lobbies from modifying the same player objects)
    lobby.availablePlayers = JSON.parse(JSON.stringify(enrichedPool.players));
    lobby.games = enrichedPool.games;
    lobby.gameDate = gameDate;
    
    console.log(`Lobby ${lobby.id}: Using enriched pool (${lobby.availablePlayers.length} players from cache)`);
    
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
    
    // Send personalized pool to the first drafter
    sendPersonalizedPlayerPool(lobby, lobby.draftOrder[0]);
    
    startDraftTimer(lobby);
    
    // Save to Firestore (non-blocking - let it happen in background)
    saveLobbyToFirestore(lobby);
    
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
      const nextDrafterId = lobby.draftOrder[lobby.currentPick];
      
      io.to(lobby.id).emit('nextPick', {
        currentPick: lobby.currentPick,
        currentDrafter: nextDrafterId,
        timePerPick: lobby.settings.timePerPick
      });
      
      // Send personalized player pool to the next drafter
      sendPersonalizedPlayerPool(lobby, nextDrafterId);
      
      startDraftTimer(lobby);
    }
    
    // Save state to Firestore after pick
    saveLobbyToFirestore(lobby);
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
  
  socket.on('leaveGame', async ({ sessionId, lobbyId }) => {
    console.log(`🚪 Player leaving game:`, { sessionId, lobbyId });
    
    const lobby = lobbies[lobbyId];
    if (!lobby) {
      console.log('❌ Lobby not found');
      return;
    }
    
    const player = lobby.players.find(p => p.id === sessionId);
    if (!player) {
      console.log('❌ Player not found in lobby');
      return;
    }
    
    console.log(`👋 ${player.name} leaving lobby ${lobbyId}`);
    
    // Save player UID before removing (for Firestore cleanup)
    const playerUid = player.uid;
    
    // Remove player from THIS lobby only
    lobby.players = lobby.players.filter(p => p.id !== sessionId);
    
    // Remove this lobby from the player's activeGames in Firestore
    if (playerUid && firestoreDb) {
      try {
        await firestoreDb.collection('users').doc(playerUid).update({
          activeGames: admin.firestore.FieldValue.arrayRemove(lobbyId)
        });
        console.log(`✅ Removed lobby ${lobbyId} from ${player.name}'s active games`);
      } catch (err) {
        console.error(`Error removing lobby from user ${playerUid}:`, err);
      }
    }
    
    // Update session to remove this lobby reference
    // (but keep session alive - they might be in other games)
    if (sessions[sessionId] && sessions[sessionId].lobbyId === lobbyId) {
      // Check if they're in any other lobbies
      const otherLobby = Object.values(lobbies).find(l => 
        l.id !== lobbyId && l.players.some(p => p.id === sessionId)
      );
      
      if (otherLobby) {
        // Update session to point to their other active lobby
        sessions[sessionId].lobbyId = otherLobby.id;
        console.log(`✅ Session updated to other active lobby: ${otherLobby.id}`);
      } else {
        // No other lobbies, can delete session
        delete sessions[sessionId];
        console.log('✅ Deleted session (no other active games)');
      }
    }
    
    // If lobby is now empty, delete it
    if (lobby.players.length === 0) {
      console.log(`🗑️ Lobby ${lobbyId} is now empty, deleting...`);
      
      // Stop any score update intervals
      if (lobby.scoreInterval) {
        clearInterval(lobby.scoreInterval);
      }
      
      // Remove from lobbies
      delete lobbies[lobbyId];
      
      // Remove from public lobbies if present
      const idx = publicLobbies.indexOf(lobbyId);
      if (idx !== -1) {
        publicLobbies.splice(idx, 1);
        console.log('✅ Removed from public lobbies');
      }
      
      // Delete from Firestore (players already removed from their activeGames above)
      if (firestoreDb) {
        deleteLobbyFromFirestore(lobbyId); // Non-blocking
      }
    } else {
      // Transfer host if needed
      if (lobby.host === sessionId) {
        lobby.host = lobby.players[0].id;
        lobby.players[0].isHost = true;
        console.log(`👑 Transferred host to ${lobby.players[0].name}`);
      }
      
      // Notify remaining players
      io.to(lobbyId).emit('playerLeft', { 
        playerName: player.name,
        remainingPlayers: lobby.players.length
      });
      
      // Update lobby state
      if (lobby.state === 'waiting') {
        io.to(lobbyId).emit('lobbyUpdate', getLobbyState(lobby));
      }
    }
    
    console.log(`✅ ${player.name} successfully left lobby ${lobbyId}`);
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
  
  // Save to Firestore (non-blocking)
  saveLobbyToFirestore(lobby);
  
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

// Cache stats endpoint — for debugging/monitoring
app.get('/api/cache-stats', (req, res) => {
  const cacheFileExists = fs.existsSync(CACHE_FILE);
  let cacheFileSize = 0, cacheFileAge = null;
  if (cacheFileExists) {
    const stat = fs.statSync(CACHE_FILE);
    cacheFileSize = Math.round(stat.size / 1024);
    cacheFileAge = Math.round((Date.now() - stat.mtimeMs) / 1000);
  }
  
  // Get enriched pool info
  const enrichedPools = [];
  for (const [key, entry] of enrichedPoolCache) {
    const age = Math.round((Date.now() - entry.timestamp) / 1000);
    enrichedPools.push({
      key,
      players: entry.data.players.length,
      games: entry.data.games.length,
      ageSeconds: age
    });
  }
  
  res.json({
    memory: {
      nhlPlayerStats: nhlPlayerStatsCache.size,
      nbaPlayerStats: nbaPlayerStatsCache.size,
      schedule: scheduleCache.size,
      boxscore: boxscoreCache.size,
      nhlRoster: nhlRosterCache.size,
      nbaRoster: nbaRosterCache.size,
      enrichedPool: enrichedPoolCache.size,
    },
    enrichedPools,
    disk: {
      file: CACHE_FILE,
      exists: cacheFileExists,
      sizeKB: cacheFileSize,
      ageSeconds: cacheFileAge,
    },
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
  // Persistent caches — use their declared TTL
  for (const { cache, ttl } of Object.values(PERSISTENT_CACHES)) {
    pruneCacheTTL(cache, ttl);
  }
  // Ephemeral caches
  pruneCacheTTL(scheduleCache, SCHEDULE_CACHE_TTL * 3);
  pruneCacheTTL(boxscoreCache, BOXSCORE_CACHE_TTL * 3);
}, 5 * 60 * 1000);

// ============================================
// START SERVER
// ============================================
// Restore active lobbies from Firestore on startup
async function restoreLobbiesFromFirestore() {
  if (!firestoreDb) {
    console.log('⏭️  Skipping Firestore restore (not configured)');
    return;
  }
  
  try {
    console.log('🔄 Restoring active lobbies from Firestore...');
    
    const snapshot = await firestoreDb.collection('lobbies')
      .where('state', 'in', ['waiting', 'drafting', 'live'])
      .get();
    
    let restoredCount = 0;
    
    snapshot.forEach(doc => {
      const lobby = doc.data();
      lobbies[lobby.id] = lobby;
      
      // Restart score intervals for live games
      if (lobby.state === 'live') {
        lobby.scoreInterval = setInterval(() => {
          updateLiveScores(lobby.id);
        }, SCORE_UPDATE_INTERVAL);
        console.log(`  ✅ Restored live game: ${lobby.id} - restarted scoring`);
      } else {
        console.log(`  ✅ Restored ${lobby.state} game: ${lobby.id}`);
      }
      
      restoredCount++;
    });
    
    console.log(`🎉 Restored ${restoredCount} active lobbies from Firestore`);
  } catch (err) {
    console.error('❌ Error restoring lobbies from Firestore:', err);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Draft Royale running on port ${PORT}`);
  
  // Restore lobbies from Firestore first
  await restoreLobbiesFromFirestore();
  
  // Then warm up cache (non-blocking)
  setTimeout(warmupCache, 2000);
});
