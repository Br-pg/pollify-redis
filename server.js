// ════════════════════════════════════════════════
//  POLLIFY — Node.js + Express Backend
//  server.js  (Redis-persistent via Upstash)
// ════════════════════════════════════════════════
//
//  ENV VARS REQUIRED:
//    UPSTASH_REDIS_REST_URL   — from Upstash dashboard
//    UPSTASH_REDIS_REST_TOKEN — from Upstash dashboard
//
//  SETUP:
//    npm install express cors uuid helmet express-rate-limit @upstash/redis
//
//  DEPLOY: Render.com / Railway.app / fly.io
// ════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── REDIS CLIENT ───
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ─── REDIS KEY HELPERS ───
const KEYS = {
  poll: (id) => `poll:${id}`,
  pollList: () => `polls:index`,       // sorted set: score=created, member=id
  vote: (pollId, ip) => `vote:${pollId}:${ip}`,
};

// ─── MIDDLEWARE ───
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(cors({ origin: '*' }));
app.use(express.json());

// Prevent stale browser caching for deployed builds
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
  }
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const voteLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
app.use('/api/', limiter);
app.use('/api/polls/:id/vote', voteLimiter);

// ─── SEED DEMO DATA (runs once if list is empty) ───
async function seedDemos() {
  try {
    const count = await redis.zcard(KEYS.pollList());
    if (count > 0) return; // already seeded

    const demos = [
      {
        id: 'demo1',
        question: 'Who should be the next NUGS President?',
        description: 'Vote for your preferred candidate.',
        options: [
          { text: 'Eugene Yensu', votes: 8 },
          { text: 'Kay', votes: 1 },
          { text: 'Barbie', votes: 1 }
        ],
        created: Date.now() - 86400000 * 2,
        dupCheck: 'ip',
        resultsVis: 'after_vote'
      },
      {
        id: 'demo2',
        question: 'Best programming language in 2025?',
        description: '',
        options: [
          { text: 'Python', votes: 14 },
          { text: 'JavaScript', votes: 11 },
          { text: 'Rust', votes: 6 },
          { text: 'Go', votes: 4 }
        ],
        created: Date.now() - 86400000,
        dupCheck: 'session',
        resultsVis: 'after_vote'
      }
    ];

    for (const demo of demos) {
      await redis.set(KEYS.poll(demo.id), JSON.stringify(demo));
      await redis.zadd(KEYS.pollList(), { score: demo.created, member: demo.id });
    }

    console.log('✅ Demo polls seeded to Redis');
  } catch (err) {
    console.error('⚠️  Redis seed error (check env vars):', err.message);
  }
}

// ─── HELPERS ───
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

function validatePoll(body) {
  const { question, options } = body;
  if (!question || typeof question !== 'string' || question.trim().length < 3) {
    return 'Question must be at least 3 characters.';
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 20) {
    return 'Provide between 2 and 20 options.';
  }
  for (const opt of options) {
    if (!opt || typeof opt !== 'string' || opt.trim().length < 1) {
      return 'Each option must have text.';
    }
  }
  return null;
}

async function getPoll(id) {
  const raw = await redis.get(KEYS.poll(id));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function savePoll(poll) {
  await redis.set(KEYS.poll(poll.id), JSON.stringify(poll));
}

// ════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════

// GET /api/polls — list all polls (newest first)
app.get('/api/polls', async (req, res) => {
  try {
    // Fetch IDs from sorted set, newest first
    const ids = await redis.zrange(KEYS.pollList(), 0, -1, { rev: true });

    const polls = await Promise.all(ids.map(id => getPoll(id)));
    const list = polls
      .filter(Boolean)
      .map(p => ({
        id: p.id,
        question: p.question,
        options: p.options,
        totalVotes: p.options.reduce((s, o) => s + o.votes, 0),
        optionCount: p.options.length,
        created: p.created
      }));

    res.json({ polls: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch polls' });
  }
});

// GET /api/polls/:id — get single poll
app.get('/api/polls/:id', async (req, res) => {
  try {
    const poll = await getPoll(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });

    const ip = getIP(req);
    const voted = !!(await redis.get(KEYS.vote(poll.id, ip)));

    res.json({
      id: poll.id,
      question: poll.question,
      description: poll.description,
      options: poll.options,
      created: poll.created,
      dupCheck: poll.dupCheck,
      resultsVis: poll.resultsVis,
      voted,
      totalVotes: poll.options.reduce((s, o) => s + o.votes, 0)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch poll' });
  }
});

// POST /api/polls — create poll
app.post('/api/polls', async (req, res) => {
  try {
    const { question, description, options, dupCheck, resultsVis } = req.body;

    const error = validatePoll({ question, options });
    if (error) return res.status(400).json({ error });

    const poll = {
      id: uuidv4(),
      question: question.trim().substring(0, 250),
      description: (description || '').trim().substring(0, 500),
      options: options.map(text => ({ text: text.trim().substring(0, 200), votes: 0 })),
      created: Date.now(),
      dupCheck: ['ip', 'session', 'none'].includes(dupCheck) ? dupCheck : 'ip',
      resultsVis: ['always', 'after_vote'].includes(resultsVis) ? resultsVis : 'always'
    };

    await savePoll(poll);
    await redis.zadd(KEYS.pollList(), { score: poll.created, member: poll.id });

    console.log(`✅ Poll created: "${poll.question}" [${poll.id}]`);
    res.status(201).json({ id: poll.id, message: 'Poll created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create poll' });
  }
});

// POST /api/polls/:id/vote — submit vote
app.post('/api/polls/:id/vote', async (req, res) => {
  try {
    const poll = await getPoll(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });

    const optionIndex = req.body.optionIndex !== undefined ? req.body.optionIndex : req.body.optionIdx;
    const ip = getIP(req);

    if (typeof optionIndex !== 'number' || optionIndex < 0 || optionIndex >= poll.options.length) {
      return res.status(400).json({ error: 'Invalid option selected.' });
    }

    // Duplicate check (IP-based)
    if (poll.dupCheck === 'ip') {
      const voteKey = KEYS.vote(poll.id, ip);
      const alreadyVoted = await redis.get(voteKey);
      if (alreadyVoted) {
        return res.status(409).json({ error: 'You already voted on this poll.' });
      }
      // Store vote record (30-day TTL)
      await redis.set(voteKey, '1', { ex: 60 * 60 * 24 * 30 });
    }

    poll.options[optionIndex].votes += 1;
    await savePoll(poll);

    console.log(`🗳️  Vote recorded for [${poll.question}] -> Choice index: ${optionIndex}`);

    res.json({
      message: 'Vote recorded!',
      options: poll.options,
      totalVotes: poll.options.reduce((s, o) => s + o.votes, 0)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// DELETE /api/polls/:id — delete poll
app.delete('/api/polls/:id', async (req, res) => {
  try {
    const exists = await redis.get(KEYS.poll(req.params.id));
    if (!exists) return res.status(404).json({ error: 'Not found' });

    await redis.del(KEYS.poll(req.params.id));
    await redis.zrem(KEYS.pollList(), req.params.id);

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete poll' });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const count = await redis.zcard(KEYS.pollList());
    res.json({ status: 'ok', polls: count, storage: 'redis' });
  } catch {
    res.json({ status: 'ok', polls: '?', storage: 'redis-error' });
  }
});

// ─── START ───
// Single Page App fallback - serve index.html for any non-API route
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.listen(PORT, async () => {
  console.log(`
  🚀 Pollify backend running on port ${PORT}
  📊 API: http://localhost:${PORT}/api/polls
  🏥 Health: http://localhost:${PORT}/api/health
  💾 Storage: Upstash Redis
  `);
  await seedDemos();
});
