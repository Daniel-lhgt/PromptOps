require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'promptops-production-secret-key-2026';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseAdmin = admin;
    console.log('✅ Firebase Admin SDK initialized successfully');
  } else if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    firebaseAdmin = admin;
    console.log('✅ Firebase Admin SDK initialized via default credentials');
  }
} catch (error) {
  console.warn(
    '⚠️ Firebase Admin SDK initialization skipped:',
    error.message
  );
}

let aiClient = null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;

if (GEMINI_API_KEY) {
  try {
    const { GoogleGenAI } = require('@google/genai');
    aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log('✅ Google Gemini API client active');
  } catch (err) {
    console.warn(
      '⚠️ @google/genai package not found or failed to load. Defaulting to internal fallback synthesis engine.'
    );
  }
} else {
  console.warn(
    '⚠️ GEMINI_API_KEY not found in environment. Operating in internal fallback mode.'
  );
}

const users = [
  {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Prompt Engineer',
    password: 'password123',
    credits: 50,
  },
];

const promptLibrary = [];
const feedbackLog = [];

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'Authentication token missing. Please sign in.',
    });
  }

  // Verify Firebase ID Token if Admin SDK is active
  if (firebaseAdmin) {
    try {
      const decodedToken = await firebaseAdmin.auth().verifyIdToken(token);
      req.user = {
        id: decodedToken.uid,
        email: decodedToken.email || '',
        name:
          decodedToken.name ||
          decodedToken.email?.split('@')[0] ||
          'User',
      };
      return next();
    } catch (fbErr) {
      // Fall through to local JWT check if Firebase verification fails
    }
  }

  // Verify standard internal JWT token
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({
        ok: false,
        error: 'Session expired or invalid authentication token.',
      });
    }
    req.user = user;
    next();
  });
}

function optionalAuthenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = { id: 'guest', name: 'Guest User', email: 'guest@promptops.ai' };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      req.user = {
        id: 'guest',
        name: 'Guest User',
        email: 'guest@promptops.ai',
      };
    } else {
      req.user = user;
    }
    next();
  });
}

async function generatePromptWithGemini(
  concept,
  mode = 'quick',
  refinement = null
) {
  const systemInstruction = `You are PromptOps, an enterprise-grade prompt engineering assistant. 
Your goal is to transform rough user ideas into production-ready system prompts and structured agent instructions.
Always respond strictly in valid JSON format with three key fields:
{
  "title": "A short, descriptive 3-5 word title for this prompt",
  "prompt": "The complete, structured system prompt with clear roles, directives, constraints, and output format",
  "explanation": "A concise 1-2 sentence explanation of why this prompt structure works well"
}`;

  let userQuery = `Create a production-grade system prompt for this concept: "${concept}".`;
  if (mode === 'agent') {
    userQuery = `Design an autonomous AI Agent System Prompt for this goal: "${concept}". Include role identity, operational step-by-step logic, safety guardrails, and output response formatting.`;
  }
  if (refinement) {
    userQuery += ` Refine based on user instruction: "${refinement}".`;
  }

  if (aiClient) {
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `${systemInstruction}\n\nTask: ${userQuery}`,
        config: {
          responseMimeType: 'application/json',
        },
      });

      let rawText = response.text || '';
      // Strip markdown code fences if returned by the LLM
      rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

      const parsed = JSON.parse(rawText);
      return {
        title: parsed.title || concept.slice(0, 30),
        prompt: parsed.prompt || rawText,
        explanation:
          parsed.explanation ||
          'Structured for optimum response consistency.',
      };
    } catch (apiError) {
      console.warn(
        'Gemini API invocation error. Using internal synthesis fallback:',
        apiError.message
      );
    }
  }

  const titleWords = concept.split(' ').slice(0, 4).join(' ');
  const formattedTitle =
    titleWords.charAt(0).toUpperCase() + titleWords.slice(1);

  const fallbackPrompt = `### SYSTEM ROLE & IDENTITY
You are an expert AI Assistant specialized in: "${concept}". Your objective is to deliver high-quality, actionable, and structured outputs tailored to the user's instructions.

### OPERATIONAL DIRECTIVES
1. **Context & Goal:** Deeply analyze user requests related to "${concept}" and provide step-by-step solutions.
2. **Tone & Style:** Maintain a clear, professional, and helpful tone throughout interactions.
3. **Constraints:**
   - Avoid generic or filler responses.
   - Ground responses in verified knowledge and practical best practices.
   - If ambiguity exists, present the most practical solution while asking brief clarifying questions.

### OUTPUT STRUCTURE
- **Summary / Direct Answer:** Clear, high-level answer or solution.
- **Detailed Execution:** Structured breakdown with bullet points, code blocks, or standard formatting.
- **Next Steps / Recommendations:** Proactive suggestions for continuous improvement.`;

  return {
    title: formattedTitle,
    prompt: fallbackPrompt,
    explanation:
      'Formatted into a production system prompt with role constraints and structured outputs.',
  };
}

// POST /api/auth/register
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ ok: false, error: 'Email and password are required' });
  }

  const existingUser = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (existingUser) {
    return res
      .status(400)
      .json({ ok: false, error: 'An account with this email already exists' });
  }

  const newUser = {
    id: `user-${Date.now()}`,
    name: name || email.split('@')[0],
    email,
    password,
    credits: 50,
  };

  users.push(newUser);

  const token = jwt.sign(
    { id: newUser.id, name: newUser.name, email: newUser.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return res.json({
    ok: true,
    token,
    user: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      credits: newUser.credits,
    },
  });
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  const user = users.find(
    (u) => u.email.toLowerCase() === (email || '').toLowerCase()
  );
  if (!user || user.password !== password) {
    return res
      .status(401)
      .json({ ok: false, error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return res.json({
    ok: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      credits: user.credits,
    },
  });
});

// GET /api/auth/me
app.get('/api/auth/me', authenticateToken, (req, res) => {
  const user = users.find((u) => u.id === req.user.id) || req.user;
  return res.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      credits: user.credits || 50,
    },
  });
});

// POST /api/prompts/quick
app.post('/api/prompts/quick', authenticateToken, async (req, res) => {
  const { concept, regenerate } = req.body;

  if (!concept) {
    return res
      .status(400)
      .json({ ok: false, error: 'Concept description is required' });
  }

  const user = users.find((u) => u.id === req.user.id);
  const cost = regenerate ? 1 : 2;

  if (user && user.credits < cost) {
    return res
      .status(403)
      .json({ ok: false, error: 'Insufficient credits for prompt generation' });
  }

  if (user) user.credits -= cost;

  try {
    const generated = await generatePromptWithGemini(concept, 'quick');

    return res.json({
      ok: true,
      id: `prompt-${Date.now()}`,
      title: generated.title,
      prompt: generated.prompt,
      explanation: generated.explanation,
      remaining_credits: user ? user.credits : 48,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to generate prompt: ' + err.message });
  }
});

// POST /api/prompts/create
app.post('/api/prompts/create', authenticateToken, async (req, res) => {
  const { concept } = req.body;

  if (!concept) {
    return res
      .status(400)
      .json({ ok: false, error: 'Concept description is required' });
  }

  const user = users.find((u) => u.id === req.user.id);
  if (user && user.credits < 2) {
    return res.status(403).json({ ok: false, error: 'Insufficient credits' });
  }

  if (user) user.credits -= 2;

  try {
    const generated = await generatePromptWithGemini(concept, 'agent');

    return res.json({
      ok: true,
      id: `prompt-${Date.now()}`,
      title: generated.title.startsWith('Agent:')
        ? generated.title
        : `Agent: ${generated.title}`,
      prompt: generated.prompt,
      explanation: generated.explanation,
      remaining_credits: user ? user.credits : 48,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to build prompt agent' });
  }
});

// POST /api/prompts/refine
app.post('/api/prompts/refine', authenticateToken, async (req, res) => {
  const { original_prompt, instructions } = req.body;

  if (!original_prompt || !instructions) {
    return res.status(400).json({
      ok: false,
      error: 'Original prompt and instructions are required',
    });
  }

  const user = users.find((u) => u.id === req.user.id);
  if (user && user.credits < 1) {
    return res.status(403).json({ ok: false, error: 'Insufficient credits' });
  }

  if (user) user.credits -= 1;

  if (aiClient) {
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Revise and improve the following AI system prompt based on these instructions.\n\nOriginal Prompt:\n${original_prompt}\n\nRefinement Instruction:\n${instructions}\n\nProvide ONLY the refined system prompt text directly without extra commentary.`,
      });

      return res.json({
        ok: true,
        prompt: response.text().trim(),
        remaining_credits: user ? user.credits : 49,
      });
    } catch (e) {
      console.warn(
        'Refinement via API failed, using fallback formatter:',
        e.message
      );
    }
  }

  const refinedPrompt = `${original_prompt}\n\n### REFINEMENT INSTRUCTIONS (${instructions.toUpperCase()})\n- Ensure outputs directly incorporate: ${instructions}\n- Streamline formatting for improved readability.`;

  return res.json({
    ok: true,
    prompt: refinedPrompt,
    remaining_credits: user ? user.credits : 49,
  });
});

// POST /api/prompts/save
app.post('/api/prompts/save', authenticateToken, (req, res) => {
  const { title, prompt, explanation } = req.body;

  if (!prompt) {
    return res
      .status(400)
      .json({ ok: false, error: 'Prompt content is required' });
  }

  const newPromptItem = {
    id: `lib-${Date.now()}`,
    userId: req.user.id,
    title: title || 'Saved Prompt',
    prompt,
    explanation: explanation || '',
    createdAt: new Date().toISOString(),
  };

  promptLibrary.unshift(newPromptItem);

  return res.json({
    ok: true,
    message: 'Prompt saved to library successfully',
    item: newPromptItem,
  });
});

// GET /api/prompts
app.get('/api/prompts', authenticateToken, (req, res) => {
  const userPrompts = promptLibrary.filter(
    (p) => p.userId === req.user.id || p.userId === 'guest'
  );
  return res.json({
    ok: true,
    prompts: userPrompts,
  });
});

// DELETE /api/prompts/:id
app.delete('/api/prompts/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const index = promptLibrary.findIndex(
    (p) => p.id === id && (p.userId === req.user.id || p.userId === 'guest')
  );

  if (index !== -1) {
    promptLibrary.splice(index, 1);
    return res.json({ ok: true, message: 'Prompt deleted successfully' });
  }

  return res.status(404).json({ ok: false, error: 'Prompt not found' });
});

// POST /api/feedback
app.post('/api/feedback', optionalAuthenticateToken, (req, res) => {
  const { type, feedback } = req.body;

  const entry = {
    id: `fb-${Date.now()}`,
    userId: req.user ? req.user.id : 'anonymous',
    type: type || 'rating',
    feedback: feedback || '',
    submittedAt: new Date().toISOString(),
  };

  feedbackLog.push(entry);

  return res.json({
    ok: true,
    message: 'Feedback received with thanks!',
  });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'PromptOps API Backend',
    status: 'healthy',
    geminiEnabled: Boolean(aiClient),
    firebaseEnabled: Boolean(firebaseAdmin),
    timestamp: new Date().toISOString(),
  });
});

// Serve static assets from project root
app.use(express.static(__dirname));

// Entrypoint route
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  const homePath = path.join(__dirname, 'home.html');

  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else if (fs.existsSync(homePath)) {
    res.sendFile(homePath);
  } else {
    res.send(
      '<h1>PromptOps Server Running</h1><p>Static files loaded successfully.</p>'
    );
  }
});

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    ok: false,
    error: 'Internal server error occurred.',
  });
});

// Start Express HTTP Server
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🚀 PromptOps Backend running on http://localhost:${PORT}`);
  console.log(`   Health Check: http://localhost:${PORT}/api/health`);
  console.log(`=================================`);
});
