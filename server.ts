import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';

interface ClassItem {
  id: string;
  name: string;
  date: string;
  instructor: string;
  createdAt: string;
}

interface ResponseItem {
  id: string;
  classId: string;
  respondentCompany: string;
  respondentName: string;
  respondentRole: string;
  respondentDept: string;
  answers: Record<string, number>;
  essay: string;
  submittedAt: string;
}

interface DatabaseSchema {
  classes: ClassItem[];
  responses: ResponseItem[];
}

const DB_PATH = path.resolve(process.cwd(), 'data/db.json');

// DB 안전 로드
function loadDb(): DatabaseSchema {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[Database] Failed to read db.json, fallback to memory default:', err);
  }
  return { classes: [], responses: [] };
}

// DB 안전 저장
function saveDb(data: DatabaseSchema): void {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Database] Failed to write db.json:', err);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // JSON 파싱 미들웨어
  app.use(express.json({ limit: '10mb' }));

  // CORS 지원 (모바일 및 다양한 브라우저 접속 원활화)
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  /* ==========================================================================
     [REST API 엔드포인트] - PC/모바일 멀티 디바이스 실시간 데이터 동기화
     ========================================================================== */

  // 1. 서버 헬스체크 및 동기화 상태
  app.get('/api/health', (req, res) => {
    const db = loadDb();
    res.json({
      status: 'ok',
      totalClasses: db.classes.length,
      totalResponses: db.responses.length,
      serverTime: new Date().toISOString()
    });
  });

  // 2. 클래스 목록 조회
  app.get('/api/classes', (req, res) => {
    const db = loadDb();
    res.json(db.classes);
  });

  // 3. 신규 클래스 개설/동기화
  app.post('/api/classes', (req, res) => {
    const newClass: ClassItem = req.body;
    if (!newClass || !newClass.id || !newClass.name) {
      return res.status(400).json({ error: 'Invalid class data' });
    }

    const db = loadDb();
    const existingIndex = db.classes.findIndex(c => c.id === newClass.id);
    if (existingIndex >= 0) {
      db.classes[existingIndex] = { ...db.classes[existingIndex], ...newClass };
    } else {
      db.classes.unshift(newClass);
    }
    saveDb(db);
    res.json({ success: true, class: newClass });
  });

  // 4. 설문 응답 목록 조회 (classId 필터링 지원)
  app.get('/api/responses', (req, res) => {
    const db = loadDb();
    const classId = req.query.classId as string | undefined;

    if (!classId || classId === 'ALL') {
      return res.json(db.responses);
    }

    const filtered = db.responses.filter(r => r.classId === classId);
    res.json(filtered);
  });

  // 5. 설문 응답 제출 (스마트폰, PC 모든 기기에서 공통 저장)
  app.post('/api/responses', (req, res) => {
    const responseItem: ResponseItem = req.body;
    if (!responseItem || !responseItem.id || !responseItem.classId) {
      return res.status(400).json({ error: 'Invalid response data' });
    }

    const db = loadDb();
    // 중복 id 방지
    const idx = db.responses.findIndex(r => r.id === responseItem.id);
    if (idx >= 0) {
      db.responses[idx] = responseItem;
    } else {
      db.responses.unshift(responseItem);
    }
    saveDb(db);

    console.log(`[API] New response from ${responseItem.respondentName} (${responseItem.classId}) - Total: ${db.responses.length}`);
    res.json({ success: true, count: db.responses.length, item: responseItem });
  });

  // 6. 가상 샘플 응답 일괄 추가
  app.post('/api/responses/batch', (req, res) => {
    const { responses } = req.body;
    if (!Array.isArray(responses)) {
      return res.status(400).json({ error: 'Array of responses required' });
    }

    const db = loadDb();
    db.responses.unshift(...responses);
    saveDb(db);

    res.json({ success: true, added: responses.length, total: db.responses.length });
  });

  // 7. 특정 과정 또는 전체 응답 데이터 초기화
  app.delete('/api/responses', (req, res) => {
    const classId = req.query.classId as string | undefined;
    const db = loadDb();

    if (classId && classId !== 'ALL') {
      const beforeCount = db.responses.length;
      db.responses = db.responses.filter(r => r.classId !== classId);
      saveDb(db);
      res.json({ success: true, removed: beforeCount - db.responses.length, remaining: db.responses.length });
    } else {
      db.responses = [];
      saveDb(db);
      res.json({ success: true, removed: 'all', remaining: 0 });
    }
  });

  /* ==========================================================================
     [Vite Middleware SPA 서빙]
     ========================================================================== */
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve('dist'))) {
    app.use(express.static('dist'));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [Full-Stack Server] Running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('[Server Error] Failed to start server:', err);
  process.exit(1);
});
