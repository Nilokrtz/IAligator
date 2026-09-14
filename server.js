require('dotenv').config();

const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const preferredPort = Number(process.env.PORT) || 3001;
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dwcopa',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
});

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

async function allQuery(sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows;
}

function normalizeQuestion(question) {
  return question
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function extractYear(normalizedQuestion) {
  const matchFull = normalizedQuestion.match(/\b(19\d{2}|20\d{2})\b/);
  if (matchFull) return matchFull[1];

  const matchShort = normalizedQuestion.match(/\b(?:de|em|\')\s*(\d{2})\b/);
  if (matchShort) {
    const twoDigits = parseInt(matchShort[1], 10);
    return twoDigits <= 30 ? `20${matchShort[1]}` : `19${matchShort[1]}`;
  }

  return null;
}

function getSearchTerm(question) {
  return question
    .replace(/\b(19\d{2}|20\d{2})\b/g, '')
    .replace(/\b(quem|qual|quais|quantos|quantas|me|mostre|mostrar|listar|lista|jogador|jogadores|selecao|selecoes|copa|copas|ano|anos|gol|gols|artilharia|artilheiro|artilheiros|assistencia|assistencias|partida|partidas|minuto|minutos|cartao|cartoes|amarelo|amarelos|vermelho|vermelhos|desempenho|fez|fizeram|marcou|marcaram|deu|deram|teve|tiveram|do|da|dos|das|de|o|a|os|as|no|na|nos|nas|em|um|uma|com|tem|foram|foi|faca|fazer|para|por|mais|menos|maior|melhor|melhores|pior|piores|mundo|geral|historico|historica|edicao|edicoes|vez|vezes|total)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getRelevantContext(question) {
  const normalizedQuestion = normalizeQuestion(question);
  const year = extractYear(normalizedQuestion);
  const searchTerm = getSearchTerm(normalizedQuestion);

  if (/o que (tem|voce tem|voce sabe)|quais dados|sobre o que|informacoes voce tem/.test(normalizedQuestion)) {
    return [
      {
        tabelas: 'dim_copa, dim_selecao, dim_jogador, dim_posicao, fato_desempenho_jogador',
        dados: 'Sedes e anos das Copas, jogadores, selecoes, gols, assistencias (a partir de 1998), minutos jogados, partidas e cartoes amarelos e vermelhos.'
      }
    ];
  }

  if (/(gol|golz|assist|cartao|cartoes|minuto|partida|jogo)/.test(normalizedQuestion) &&
    /(mais|maior|lider|artilheiro|top|melhor|recordista|campeao de)/.test(normalizedQuestion) &&
    /jogador/.test(normalizedQuestion)) {

  // Mapeia palavra-chave da pergunta -> coluna do banco + rótulo amigável
  const statMap = [
    { regex: /cartao amarelo|cartoes amarelos/, column: 'Cartoes_Amarelos', label: 'cartoes_amarelos' },
    { regex: /cartao vermelho|cartoes vermelhos/, column: 'Cartoes_Vermelhos', label: 'cartoes_vermelhos' },
    { regex: /cartao|cartoes/, column: 'Cartoes_Amarelos', label: 'cartoes_amarelos' }, 
    { regex: /assist/, column: 'Assistencias', label: 'assistencias' },
    { regex: /minuto|tempo de jogo|tempo em campo/, column: 'Minutos_Jogados', label: 'minutos_jogados' },
    { regex: /partida|partidas|jogo|jogos|jogou|disputou|atuou/, column: 'Partidas_Jogadas', label: 'partidas_jogadas' },
    { regex: /gol/, column: 'Gols', label: 'gols' },
  ];

  const stat = statMap.find(s => s.regex.test(normalizedQuestion));

  if (stat) {
    const isAscending = /menos|pior|menor/.test(normalizedQuestion);
    const order = isAscending ? 'ASC' : 'DESC';

    if (year) {
      return allQuery(`
        SELECT 
          j.Nome_Jogador AS jogador, 
          s.Nome_Selecao AS selecao,
          c.Ano AS copa,
          f.${stat.column} AS ${stat.label}
        FROM fato_desempenho_jogador f
        INNER JOIN dim_jogador j ON j.ID_Jogador = f.ID_Jogador
        INNER JOIN dim_selecao s ON s.ID_Selecao = f.ID_Selecao
        INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
        WHERE c.Ano = ? AND f.${stat.column} IS NOT NULL
        ORDER BY f.${stat.column} ${order}
        LIMIT 5
      `, [year]);
    }

    return allQuery(`
      SELECT 
        j.Nome_Jogador AS jogador, 
        s.Nome_Selecao AS selecao,
        c.Ano AS copa,
        f.${stat.column} AS ${stat.label}
      FROM fato_desempenho_jogador f
      INNER JOIN dim_jogador j ON j.ID_Jogador = f.ID_Jogador
      INNER JOIN dim_selecao s ON s.ID_Selecao = f.ID_Selecao
      INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
      WHERE f.${stat.column} IS NOT NULL
      ORDER BY f.${stat.column} ${order}
      LIMIT 5
    `);
  }
}

  if (/\b(copa|copas|sede|sedes)\b/.test(normalizedQuestion) && !/jogador|gol|artilh|assist|minuto|cartao|cartoes|partida|selecao|pais/.test(normalizedQuestion)) {
    if (year) {
      return allQuery(
        'SELECT ID_Copa AS id_copa, Ano AS ano, Sede AS sede FROM dim_copa WHERE Ano = ? ORDER BY Ano',
        [year]
      );
    }
    return allQuery('SELECT ID_Copa AS id_copa, Ano AS ano, Sede AS sede FROM dim_copa ORDER BY Ano');
  }

  if (/mais (vezes|edicoes|participou|apareceu|jogou|disputou|atuou)|maior participac/.test(normalizedQuestion) && /selecao|selecoes|pais|paises/.test(normalizedQuestion)) {
    return allQuery(`
      SELECT s.Nome_Selecao AS selecao, COUNT(DISTINCT f.ID_Copa) AS total_edicoes
      FROM fato_desempenho_jogador f
      INNER JOIN dim_selecao s ON s.ID_Selecao = f.ID_Selecao
      GROUP BY s.ID_Selecao, s.Nome_Selecao
      ORDER BY total_edicoes DESC
      LIMIT 10
    `);
  }

 if (/mais velho|mais idoso|maior idade/.test(normalizedQuestion) && /jogador/.test(normalizedQuestion)) {
  return allQuery(`
    SELECT 
      j.Nome_Jogador AS jogador, 
      f.Idade_na_Copa AS idade,
      s.Nome_Selecao AS selecao,
      c.Ano AS copa
    FROM fato_desempenho_jogador f
    INNER JOIN dim_jogador j ON j.ID_Jogador = f.ID_Jogador
    INNER JOIN dim_selecao s ON s.ID_Selecao = f.ID_Selecao
    INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
    WHERE f.Idade_na_Copa IS NOT NULL
    ORDER BY f.Idade_na_Copa DESC
    LIMIT 5
  `);
}

if (/mais novo|mais jovem|menor idade/.test(normalizedQuestion) && /jogador/.test(normalizedQuestion)) {
  return allQuery(`
    SELECT 
      j.Nome_Jogador AS jogador, 
      f.Idade_na_Copa AS idade,
      s.Nome_Selecao AS selecao,
      c.Ano AS copa
    FROM fato_desempenho_jogador f
    INNER JOIN dim_jogador j ON j.ID_Jogador = f.ID_Jogador
    INNER JOIN dim_selecao s ON s.ID_Selecao = f.ID_Selecao
    INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
    WHERE f.Idade_na_Copa IS NOT NULL
    ORDER BY f.Idade_na_Copa ASC
    LIMIT 5
  `);
}

  if (/quant(os|as)|total de|numero de/.test(normalizedQuestion) && year && !/jogador/.test(normalizedQuestion)) {
    if (/assist/.test(normalizedQuestion)) {
      return allQuery(`
        SELECT c.Ano AS copa, SUM(f.Assistencias) AS total_assistencias
        FROM fato_desempenho_jogador f
        INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
        WHERE c.Ano = ?
        GROUP BY c.Ano
      `, [year]);
    }
    if (/cartao vermelho|cartoes vermelhos/.test(normalizedQuestion)) {
      return allQuery(`
        SELECT c.Ano AS copa, SUM(f.Cartoes_Vermelhos) AS total_cartoes_vermelhos
        FROM fato_desempenho_jogador f
        INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
        WHERE c.Ano = ?
        GROUP BY c.Ano
      `, [year]);
    }
    if (/cartao|cartoes/.test(normalizedQuestion)) {
      return allQuery(`
        SELECT c.Ano AS copa, SUM(f.Cartoes_Amarelos) AS total_cartoes_amarelos
        FROM fato_desempenho_jogador f
        INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
        WHERE c.Ano = ?
        GROUP BY c.Ano
      `, [year]);
    }
    if (/minuto/.test(normalizedQuestion)) {
      return allQuery(`
        SELECT c.Ano AS copa, SUM(f.Minutos_Jogados) AS total_minutos
        FROM fato_desempenho_jogador f
        INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
        WHERE c.Ano = ?
        GROUP BY c.Ano
      `, [year]);
    }
    if (/gol/.test(normalizedQuestion)) {
      return allQuery(`
        SELECT c.Ano AS copa, SUM(f.Gols) AS total_gols
        FROM fato_desempenho_jogador f
        INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
        WHERE c.Ano = ?
        GROUP BY c.Ano
      `, [year]);
    }
  }

  if (/\b(selecao|selecoes|pais|paises)\b/.test(normalizedQuestion) && !/jogador|gol|artilh|assist|minuto|cartao|cartoes|partida/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT DISTINCT s.ID_Selecao AS id_selecao, s.Nome_Selecao AS selecao, s.Sigla AS sigla
       FROM dim_selecao s
       INNER JOIN fato_desempenho_jogador f ON f.ID_Selecao = s.ID_Selecao
       ORDER BY s.Nome_Selecao`
    );
  }

  const filters = [];
  const params = [];

  if (year) {
    filters.push('c.Ano = ?');
    params.push(year);
  }

  if (searchTerm && searchTerm.length >= 3 && !/assist|gol|cartao|cartoes|amarel|vermelh|minut/.test(searchTerm)) {
    filters.push(`(
      LOWER(j.Nome_Jogador) LIKE ? OR
      LOWER(s.Nome_Selecao) LIKE ? OR
      LOWER(s.Sigla) LIKE ? OR
      LOWER(p.Nome_Posicao) LIKE ?
    )`);
    const likeTerm = `%${searchTerm}%`;
    params.push(likeTerm, likeTerm, likeTerm, likeTerm);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const joins = `
    FROM fato_desempenho_jogador f
    INNER JOIN dim_jogador j ON j.ID_Jogador = f.ID_Jogador
    INNER JOIN dim_selecao s ON s.ID_Selecao = f.ID_Selecao
    INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
    LEFT JOIN dim_posicao p ON p.ID_Posicao = f.ID_Posicao
  `;

  if (/selecao|selecoes|pais|paises/.test(normalizedQuestion) && /gol|gols|marcou|marcaram|fez gol|fizeram gols|balancou as redes/.test(normalizedQuestion) && !/jogador/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT s.Nome_Selecao AS selecao, c.Ano AS copa, SUM(f.Gols) AS total_gols
       ${joins}
       ${whereClause}
       GROUP BY s.ID_Selecao, s.Nome_Selecao, c.Ano
       ORDER BY total_gols DESC
       LIMIT 10`,
      params
    );
  }

  if (/assist/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao, c.Ano AS copa,
              SUM(f.Assistencias) AS assistencias, SUM(f.Partidas_Jogadas) AS partidas
       ${joins}
       ${whereClause}
       GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao, c.Ano
       ORDER BY assistencias DESC, partidas ASC
       LIMIT 10`,
      params
    );
  }

  if (/cartao.*vermelh|vermelho/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao, c.Ano AS copa,
              SUM(f.Cartoes_Vermelhos) AS cartoes_vermelhos, SUM(f.Partidas_Jogadas) AS partidas
       ${joins}
       ${whereClause}
       GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao, c.Ano
       ORDER BY cartoes_vermelhos DESC
       LIMIT 10`,
      params
    );
  }

  if (/cartao.*amarel|amarelo|cartao|cartoes/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao, c.Ano AS copa,
              SUM(f.Cartoes_Amarelos) AS cartoes_amarelos, SUM(f.Partidas_Jogadas) AS partidas
       ${joins}
       ${whereClause}
       GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao, c.Ano
       ORDER BY cartoes_amarelos DESC
       LIMIT 10`,
      params
    );
  }

  if (/partida|partidas|jogou mais|mais jogou|disputou mais|mais disputou|atuou mais|mais atuou/.test(normalizedQuestion) && !/minuto|minutos|tempo/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao, c.Ano AS copa,
              SUM(f.Partidas_Jogadas) AS partidas, SUM(f.Minutos_Jogados) AS minutos_jogados
       ${joins}
       ${whereClause}
       GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao, c.Ano
       ORDER BY partidas DESC, minutos_jogados DESC
       LIMIT 10`,
      params
    );
  }

  if (/minuto|minutos|tempo de jogo|tempo em campo|tempo/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao, c.Ano AS copa,
              SUM(f.Minutos_Jogados) AS minutos_jogados, SUM(f.Partidas_Jogadas) AS partidas
       ${joins}
       ${whereClause}
       GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao, c.Ano
       ORDER BY minutos_jogados DESC
       LIMIT 10`,
      params
    );
  }

  if (/gol|gols|artilh|marcou|marcaram|fez gol|fizeram gols|goleador/.test(normalizedQuestion)) {
    return allQuery(
      `SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao, c.Ano AS copa,
              SUM(f.Gols) AS gols, SUM(f.Partidas_Jogadas) AS partidas
       ${joins}
       ${whereClause}
       GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao, c.Ano
       ORDER BY gols DESC, partidas ASC
       LIMIT 10`,
      params
    );
  }

  return allQuery(
    `SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao,
            p.Nome_Posicao AS posicao, c.Ano AS copa, c.Sede AS sede,
            f.Partidas_Jogadas AS partidas, f.Titular AS titular,
            f.Minutos_Jogados AS minutos, f.Gols AS gols,
            f.Assistencias AS assistencias, f.Cartoes_Amarelos AS cartoes_amarelos,
            f.Cartoes_Vermelhos AS cartoes_vermelhos
     ${joins}
     ${whereClause}
     ORDER BY c.Ano DESC, f.Gols DESC, f.Minutos_Jogados DESC
     LIMIT 15`,
    params
  );
}

function formatContext(context) {
  if (!Array.isArray(context) || context.length === 0) {
    return 'Nenhum dado encontrado no banco para esta pergunta.';
  }

  return JSON.stringify(context, null, 2);
}

async function getAIResponse(question, context) {
  const formattedContext = formatContext(context);

  if (!gemini) {
    if (!context || context.length === 0) {
      return 'Não encontrei informações no banco que correspondam à sua pergunta.';
    }
    return `Com base nos dados do banco, encontrei: ${JSON.stringify(context.slice(0, 3))}.`;
  }

  const prompt = `Você é um assistente que responde perguntas sobre as Copas do Mundo usando estritamente o contexto retornado do banco de dados MySQL.

IMPORTANTE SOBRE FALHAS NA BASE: esta base de dados foi construída a partir de uma fonte que possui diversas falhas e lacunas de preenchimento — vários campos estatísticos (como assistências, cartões, minutos, etc.) estão nulos ou ausentes para determinadas Copas ou jogadores, mesmo quando deveriam existir. Isso é uma limitação conhecida dos dados de origem, não um erro do sistema.
Se o contexto retornado vier vazio ou com valores nulos para o que foi perguntado, NÃO diga apenas "não encontrei informação suficiente". Em vez disso, explique que a base de dados utilizada possui falhas de preenchimento e que o dado solicitado não está disponível para essa Copa ou jogador especificamente por causa dessa limitação da fonte original.
Se não houver dados suficientes ou o retorno for vazio, diga que não encontrou informação suficiente no banco de dados, mas atribua eventualmente essa ausência a falhas de preenchimento na base original, especialmente quando a lacuna é pontual dentro de uma série de outros anos que têm dados completos (ex: assistências ausentes numa Copa específica, mas presentes em outras).
IMPORTANTE: Responda em texto simples e contínuo. Não use formatação Markdown, nunca use negrito (** ou __), nem itálico, nem asteriscos como marcadores de lista.

Pergunta do usuário: ${question}

Contexto do banco: ${formattedContext}`;

  const response = await callGeminiWithRetry(prompt);

  let rawText = response.text?.trim() || 'Não consegui gerar uma resposta.';
  rawText = rawText.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1');

  return rawText;
}

async function callGeminiWithRetry(prompt, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await gemini.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt
      });
    } catch (error) {
      lastError = error;
      const isOverloaded = error.status === 503 || error.message?.includes('UNAVAILABLE');

      if (isOverloaded && attempt < maxRetries) {
        const waitTime = attempt * 1000;
        console.log(`Gemini sobrecarregado, tentando novamente em ${waitTime}ms (tentativa ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
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

    if (error.status === 429) {
      return res.status(429).json({
        error: 'Limite da API Gemini atingido.',
        answer: 'O limite de requisições por minuto da IA foi atingido. Aguarde cerca de 1 minuto antes de enviar outra pergunta.'
      });
    }

    const databaseUnavailable = ['ECONNREFUSED', 'ENOTFOUND', 'ER_ACCESS_DENIED_ERROR'].includes(error.code);
    res.status(databaseUnavailable ? 503 : 500).json({
      error: databaseUnavailable
        ? 'Não foi possível acessar o banco dwcopa. Verifique o MySQL e as variáveis DB_* no arquivo .env.'
        : 'Ocorreu um erro ao consultar o banco e gerar a resposta.',
      answer: databaseUnavailable
        ? 'O banco de dados está indisponível no momento.'
        : 'Ocorreu um erro ao consultar o banco e gerar a resposta.'
    });
  }
});

async function startServer() {
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