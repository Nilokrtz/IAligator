const chatHistory = document.getElementById('chatHistory');
const questionInput = document.getElementById('questionInput');
const sendButton = document.getElementById('sendButton');

function addMessage(text, type = 'ai') {
  const message = document.createElement('div');
  message.className = `message ${type === 'user' ? 'user-message' : 'ai-message'}`;
  message.textContent = text;
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

    addMessage(data.answer || 'Sem resposta disponível.', 'ai');
  } catch (error) {
    addMessage(error.message || 'Não foi possível responder.', 'ai');
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
