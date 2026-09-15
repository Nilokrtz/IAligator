const chatHistory = document.getElementById('chatHistory');
const questionInput = document.getElementById('questionInput');
const sendButton = document.getElementById('sendButton');

function addMessage(text, type = 'ai', meta = {}) {
  const message = document.createElement('div');
  message.className = `message ${type === 'user' ? 'user-message' : 'ai-message'}`;

  if (type === 'ai' && meta && (meta.provider || meta.model)) {
    const badge = document.createElement('div');
    const isNemotron = meta.provider === 'nemotron' || (meta.model && meta.model.includes('nemotron'));
    badge.className = `ai-badge ${isNemotron ? 'badge-nvidia' : 'badge-gemini'}`;

    if (isNemotron) {
      badge.innerHTML = `
        <svg class="ai-badge-icon" viewBox="0 0 24 24" width="14" height="14" fill="#76B900">
          <path d="M7.74 3.79c-3.1 1.05-4.8 3.52-4.8 6.94 0 5.61 4.54 10.15 10.15 10.15 3.32 0 6.27-1.59 8.16-4.04l-2.92-2.1c-1.25 1.76-3.17 2.82-5.24 2.82-3.8 0-6.83-2.95-6.83-6.83 0-2.3 1.13-4.27 2.88-5.46L7.74 3.79zM12.92 7.02c-2.07 0-3.76 1.69-3.76 3.76 0 2.07 1.69 3.76 3.76 3.76 1.48 0 2.76-.86 3.38-2.1l2.42 1.4c-1.15 2.1-3.32 3.5-5.8 3.5-3.62 0-6.56-2.94-6.56-6.56 0-3.62 2.94-6.56 6.56-6.56 2.48 0 4.65 1.4 5.8 3.5l-2.42 1.4c-.62-1.24-1.9-2.1-3.38-2.1z"/>
        </svg>
        <span>NVIDIA Nemotron</span>
      `;
      badge.title = `Modelo: ${meta.model || 'nvidia/nemotron-3-ultra-550b-a55b:free'}`;
    } else {
      const modelName = meta.model ? meta.model.replace('models/', '') : 'Gemini';
      badge.innerHTML = `
        <svg class="ai-badge-icon" viewBox="0 0 24 24" width="14" height="14">
          <path d="M12 2L14.4 8.6L21 11L14.4 13.4L12 20L9.6 13.4L3 11L9.6 8.6L12 2Z" fill="url(#geminiGrad)" />
          <defs>
            <linearGradient id="geminiGrad" x1="3" y1="2" x2="21" y2="20" gradientUnits="userSpaceOnUse">
              <stop stop-color="#1BA1E2" />
              <stop offset="0.5" stop-color="#7B5EE8" />
              <stop offset="1" stop-color="#E24A4A" />
            </linearGradient>
          </defs>
        </svg>
        <span>${modelName.includes('gemini') ? modelName : 'Gemini'}</span>
      `;
      badge.title = `Modelo ativo: ${meta.model || 'gemini'}`;
    }

    message.appendChild(badge);
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = text;
  message.appendChild(content);

  chatHistory.appendChild(message);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function setLoading(isLoading) {
  const loadingMessage = document.getElementById('loading-message');

  if (isLoading) {
    if (!loadingMessage) {
      const message = document.createElement('div');
      message.id = 'loading-message';
      message.className = 'message ai-message';
      message.textContent = 'Pensando...';
      chatHistory.appendChild(message);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
    return;
  }

  if (loadingMessage) {
    loadingMessage.remove();
  }
}

async function sendQuestion() {
  const question = questionInput.value.trim();

  if (!question) {
    return;
  }

  addMessage(question, 'user');
  questionInput.value = '';
  setLoading(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ question })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao consultar a IA');
    }

    addMessage(data.answer || 'Sem resposta disponível.', 'ai', {
      provider: data.provider,
      model: data.model
    });
  } catch (error) {
    const message = error instanceof TypeError && error.message === 'Failed to fetch'
      ? 'Não foi possível conectar ao servidor. Execute npm start e verifique se o MySQL está ativo.'
      : error.message || 'Não foi possível responder.';
    addMessage(message, 'ai');
  } finally {
    setLoading(false);
  }
}

sendButton.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendQuestion();
  }
});
