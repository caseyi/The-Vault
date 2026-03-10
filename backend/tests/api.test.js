/**
 * API integration tests for server.js endpoints
 *
 * Uses a SQL-routing mock for better-sqlite3 that intercepts db.prepare()
 * and returns appropriate mock data based on the SQL string.
 *
 * Run with: npx jest tests/api.test.js
 */

// ── Mock data ────────────────────────────────────────────────────────────────

let mockModels, mockCreators, mockFiles, mockScanLog;

function mockReset() {
  mockCreators = [
    { id: 1, name: 'ArtistA', folder_path: '/test/library/ArtistA', notes: null, render_zip_hint: null },
  ];
  mockModels = [
    {
      id: 1, uuid: 'uuid-1', name: 'Dragon', creator_id: 1, creator_name: 'ArtistA',
      folder_path: '/test/library/ArtistA/Dragon', print_status: 'unprinted',
      tags: '["mini","dragon"]', images: '["/images/uuid-1/r.png"]',
      file_count: 3, has_stl: 1, has_chitubox: 0, has_lychee: 0, has_plate: 0,
      thumbnail_path: '/images/uuid-1/r.png', source_url: null, source_site: null,
      description: null, notes: null, render_zip_hint: null,
    },
    {
      id: 2, uuid: 'uuid-2', name: 'Terrain', creator_id: 1, creator_name: 'ArtistA',
      folder_path: '/test/library/ArtistA/Terrain', print_status: 'printed',
      tags: '["terrain"]', images: '[]',
      file_count: 2, has_stl: 1, has_chitubox: 0, has_lychee: 0, has_plate: 0,
      thumbnail_path: null, source_url: null, source_site: null,
      description: null, notes: null, render_zip_hint: null,
    },
  ];
  mockFiles = [
    { id: 1, model_id: 1, filename: 'dragon.stl', filepath: '/test/library/ArtistA/Dragon/dragon.stl', filetype: 'stl', filesize: 1024000, release_name: null },
    { id: 2, model_id: 1, filename: 'renders.zip', filepath: '/test/library/ArtistA/Dragon/renders.zip', filetype: 'zip', filesize: 5120000, release_name: null },
  ];
  mockScanLog = [];
}

// ── Mock db with SQL routing ────────────────────────────────────────────────

jest.mock('../db', () => {
  const mockMakeStmt = (sql) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    return {
      get: jest.fn((...args) => {
        if (s.includes('COUNT(*)') && s.includes('FROM models') && s.includes('cnt'))
          return { cnt: mockModels.length };
        if (s.includes('thumbnail_path IS NOT NULL'))
          return { n: mockModels.filter(m => m.thumbnail_path).length };
        if (s.includes('COUNT(*)') && s.includes('FROM models') && s.includes(' n '))
          return { n: mockModels.length };
        if (s.includes('COUNT(*)') && s.includes('FROM creators'))
          return { n: mockCreators.length };
        if (s.includes('FROM scan_log'))
          return mockScanLog[0] || null;
        if (s.includes('FROM models') && s.includes('WHERE') && s.includes('m.id'))
          return mockModels.find(m => m.id == args[0]) || null;
        if (s.includes('FROM models') && s.includes('WHERE') && s.includes('id = ?'))
          return mockModels.find(m => m.id == args[0]) || null;
        if (s.includes('FROM creators') && s.includes('WHERE'))
          return mockCreators.find(c => c.id == args[0]) || null;
        return null;
      }),
      all: jest.fn((...args) => {
        if (s.includes('model_files') && s.includes('WHERE'))
          return mockFiles.filter(f => f.model_id == args[0]);
        if (s.includes('FROM models') && s.includes('GROUP BY'))
          return [{ print_status: 'unprinted', n: 1 }, { print_status: 'printed', n: 1 }];
        if (s.includes('FROM models'))
          return mockModels;
        if (s.includes('FROM creators'))
          return mockCreators.map(c => ({ ...c, model_count: mockModels.filter(m => m.creator_id === c.id).length }));
        return [];
      }),
      run: jest.fn((...args) => {
        if (s.includes('UPDATE models SET')) {
          return { changes: 1 };
        }
        return { changes: 0 };
      }),
      bind: jest.fn(function () { return this; }),
    };
  };
  return {
    prepare: jest.fn((sql) => mockMakeStmt(sql)),
    exec: jest.fn(),
    transaction: jest.fn((fn) => fn),
  };
});

jest.mock('../scanner', () => ({
  scanLibrary: jest.fn().mockResolvedValue({
    modelsFound: 0, modelsAdded: 0, modelsUpdated: 0, modelsSkipped: 0,
  }),
  LIBRARY_PATH: '/test/library',
  matchesHint: jest.fn(),
  pickRenderZips: jest.fn(),
  analyzeFolder: jest.fn(),
  inferReleaseName: jest.fn(),
}));

jest.mock('../scraper', () => ({
  scrapeImagesFromUrl: jest.fn(),
  detectUrlFromFolderName: jest.fn(),
}));

jest.spyOn(console, 'log').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');

beforeEach(() => {
  mockReset();
});

// ── Health ────────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  test('returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.libraryPath).toBe('/test/library');
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

describe('GET /api/stats', () => {
  test('returns counts', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.creators).toBe(1);
    expect(res.body.withImages).toBe(1);
  });
});

// ── Models list ───────────────────────────────────────────────────────────────

describe('GET /api/models', () => {
  test('returns models with parsed tags', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body.models.length).toBe(2);
    expect(res.body.total).toBe(2);
    expect(Array.isArray(res.body.models[0].tags)).toBe(true);
  });

  test('includes pagination info', async () => {
    const res = await request(app).get('/api/models');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('pages');
  });
});

// ── Model detail ──────────────────────────────────────────────────────────────

describe('GET /api/models/:id', () => {
  test('returns model with files', async () => {
    const res = await request(app).get('/api/models/1');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Dragon');
    expect(res.body.files.length).toBe(2);
    expect(Array.isArray(res.body.tags)).toBe(true);
    expect(Array.isArray(res.body.images)).toBe(true);
  });

  test('returns 404 for nonexistent', async () => {
    const res = await request(app).get('/api/models/99999');
    expect(res.status).toBe(404);
  });
});

// ── Model update ──────────────────────────────────────────────────────────────

describe('PATCH /api/models/:id', () => {
  test('updates print_status', async () => {
    const res = await request(app).patch('/api/models/1').send({ print_status: 'printed' });
    expect(res.status).toBe(200);
  });

  test('updates tags as JSON', async () => {
    const res = await request(app).patch('/api/models/1').send({ tags: ['a', 'b'] });
    expect(res.status).toBe(200);
  });

  test('updates thumbnail_path', async () => {
    const res = await request(app).patch('/api/models/1').send({ thumbnail_path: '/images/uuid-1/new.png' });
    expect(res.status).toBe(200);
  });

  test('rejects empty update', async () => {
    const res = await request(app).patch('/api/models/1').send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 for nonexistent', async () => {
    const res = await request(app).patch('/api/models/99999').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

// ── Bulk actions ──────────────────────────────────────────────────────────────

describe('POST /api/models/bulk', () => {
  test('rejects missing ids', async () => {
    const res = await request(app).post('/api/models/bulk').send({ print_status: 'printed' });
    expect(res.status).toBe(400);
  });

  test('rejects empty ids array', async () => {
    const res = await request(app).post('/api/models/bulk').send({ ids: [], print_status: 'printed' });
    expect(res.status).toBe(400);
  });

  test('accepts valid bulk update', async () => {
    const res = await request(app).post('/api/models/bulk').send({ ids: [1, 2], print_status: 'sliced' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBeDefined();
  });
});

// ── Creators ──────────────────────────────────────────────────────────────────

describe('GET /api/creators', () => {
  test('returns creators with model counts', async () => {
    const res = await request(app).get('/api/creators');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].model_count).toBe(2);
  });
});

// ── Tags ──────────────────────────────────────────────────────────────────────

describe('GET /api/tags', () => {
  test('returns aggregated tag counts', async () => {
    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map(t => t.tag);
    expect(names).toContain('mini');
    expect(names).toContain('dragon');
    expect(names).toContain('terrain');
  });
});

// ── Scan status ───────────────────────────────────────────────────────────────

describe('GET /api/scan/status', () => {
  test('returns scan state', async () => {
    const res = await request(app).get('/api/scan/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.inProgress).toBe('boolean');
  });
});
