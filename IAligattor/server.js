require('dotenv').config();

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const OpenAI = require('openai');

const app = express();
const preferredPort = Number(process.env.PORT) || 3001;
const dbPath = path.join(__dirname, 'database.sqlite');

const db = new sqlite3.Database(dbPath);

const openai = process.env.OPENROUTER_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1'
    })
  : null;

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDatabase() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT,
      cidade TEXT,
      status TEXT DEFAULT 'ativo'
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER,
      produto TEXT NOT NULL,
      valor REAL NOT NULL,
      data TEXT NOT NULL,
      status TEXT DEFAULT 'pendente',
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )
  `);

  const clientes = await allQuery('SELECT COUNT(*) AS total FROM clientes');
  if ((clientes[0]?.total || 0) === 0) {
    const clientesSeed = [
      ['João Silva', 'joao@empresa.com', 'São Paulo', 'ativo'],
      ['Maria Souza', 'maria@empresa.com', 'Rio de Janeiro', 'ativo'],
      ['Pedro Lima', 'pedro@empresa.com', 'Belo Horizonte', 'inativo'],
      ['Ana Costa', 'ana@empresa.com', 'Curitiba', 'ativo']
    ];

    for (const cliente of clientesSeed) {
      await runQuery(
        'INSERT INTO clientes (nome, email, cidade, status) VALUES (?, ?, ?, ?)',
        cliente
      );
    }
  }

  const pedidos = await allQuery('SELECT COUNT(*) AS total FROM pedidos');
  if ((pedidos[0]?.total || 0) === 0) {
    const pedidosSeed = [
      [1, 'Notebook', 3500.00, '2026-08-01', 'pago'],
      [1, 'Mouse', 120.00, '2026-08-10', 'pago'],
      [2, 'Monitor', 1400.00, '2026-08-15', 'pendente'],
      [3, 'Teclado', 200.00, '2026-08-16', 'pago'],
      [4, 'Webcam', 650.00, '2026-08-18', 'pago']
    ];

    for (const pedido of pedidosSeed) {
      await runQuery(
        'INSERT INTO pedidos (cliente_id, produto, valor, data, status) VALUES (?, ?, ?, ?, ?)',
        pedido
      );
    }
  }
}

function normalizeQuestion(question) {
  return question.toLowerCase().trim();
}

async function getRelevantContext(question) {
  const q = normalizeQuestion(question);

  if (!q) {
    return [];
  }

  if (/(cliente|clientes|contato|email|cidade|status)/.test(q)) {
    const termo = q.replace(/(cliente|clientes|contato|email|cidade|status|quem|qual|quais|o|a|os|as)/g, '').trim();
    const likeTerm = termo ? `%${termo}%` : '%';

    return allQuery(
      `
        SELECT id, nome, email, cidade, status
        FROM clientes
        WHERE nome LIKE ? OR email LIKE ? OR cidade LIKE ?
        ORDER BY nome
        LIMIT 10
      `,
      [likeTerm, likeTerm, likeTerm]
    );
  }

  if (/(pedido|pedidos|venda|vendas|valor|produto|status do pedido|faturamento)/.test(q)) {
    const termo = q.replace(/(pedido|pedidos|venda|vendas|valor|produto|status do pedido|faturamento|qual|quais|o|a|os|as)/g, '').trim();
    const likeTerm = termo ? `%${termo}%` : '%';

    return allQuery(
      `
        SELECT p.id, c.nome AS cliente, p.produto, p.valor, p.data, p.status
        FROM pedidos p
        LEFT JOIN clientes c ON c.id = p.cliente_id
        WHERE c.nome LIKE ? OR p.produto LIKE ? OR p.status LIKE ?
        ORDER BY p.data DESC
        LIMIT 10
      `,
      [likeTerm, likeTerm, likeTerm]
    );
  }

  if (/(faturamento|total|receita|gasto|ganho)/.test(q)) {
    return allQuery(`
      SELECT c.nome, SUM(p.valor) AS total_gasto
      FROM clientes c
      LEFT JOIN pedidos p ON p.cliente_id = c.id
      GROUP BY c.id, c.nome
      ORDER BY total_gasto DESC
      LIMIT 10
    `);
  }

  return allQuery(`
    SELECT c.nome, c.email, c.cidade, COUNT(p.id) AS total_pedidos, COALESCE(SUM(p.valor), 0) AS valor_total
    FROM clientes c
    LEFT JOIN pedidos p ON p.cliente_id = c.id
    GROUP BY c.id, c.nome, c.email, c.cidade
    ORDER BY valor_total DESC
    LIMIT 10
  `);
}

function formatContext(context) {
  if (!Array.isArray(context) || context.length === 0) {
    return 'Nenhum dado encontrado no banco para esta pergunta.';
  }

  return JSON.stringify(context, null, 2);
}

async function getAIResponse(question, context) {
  const formattedContext = formatContext(context);

  if (!openai) {
    if (!context || context.length === 0) {
      return 'Não encontrei informações no banco que correspondam à sua pergunta.';
    }

    const firstRow = context[0];
    if (firstRow && firstRow.total_gasto !== undefined) {
      return `Com base no banco, o maior faturamento está em ${firstRow.nome} com total de R$ ${Number(firstRow.total_gasto).toFixed(2)}.`;
    }

    return `Com base nos dados do banco, encontrei: ${JSON.stringify(context.slice(0, 3))}.`;
  }

const completion = await openai.chat.completions.create({
  model: 'openai/gpt-4o',
  messages: [
    {
      role: 'system',
      content: 'Você é um assistente que responde somente com base no contexto do banco de dados fornecido. Se não houver dados suficientes, diga que não encontrou informação suficiente.'
    },
    {
      role: 'user',
      content: `Pergunta do usuário: ${question}\n\nContexto do banco: ${formattedContext}`
    }
  ],
  temperature: 0.2,
  provider: {
    order: ['OpenAI']
  }
});''

  return completion.choices[0]?.message?.content?.trim() || 'Não consegui gerar uma resposta.';
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, message: 'API funcionando' });
});

app.post('/api/chat', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();

    if (!question) {
      return res.status(400).json({ error: 'Pergunta obrigatória.' });
    }

    const context = await getRelevantContext(question);
    const answer = await getAIResponse(question, context);

    res.json({
      answer,
      question,
      context
    });
  } catch (error) {
    console.error('Erro ao processar pergunta:', error);
    res.status(500).json({
      answer: 'Ocorreu um erro ao consultar o banco e gerar a resposta.'
    });
  }
});

async function startServer() {
  await initDatabase();

  const candidatePorts = Array.from(new Set([preferredPort, 3002, 3003, 3004, 3005, 3010]));

  for (const port of candidatePorts) {
    try {
      await new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
          console.log(`Servidor rodando em http://localhost:${port}`);
          resolve();
        });

        server.on('error', (error) => {
          if (error.code === 'EADDRINUSE') {
            reject(error);
            return;
          }

          reject(error);
        });
      });
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }

  throw new Error('Não foi possível iniciar o servidor porque todas as portas disponíveis estão ocupadas.');
}

startServer().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
