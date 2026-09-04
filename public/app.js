const form = document.querySelector('#compare-form');
const urlInput = document.querySelector('#product-url');
const searchButton = document.querySelector('#search-button');
const results = document.querySelector('#results');
const loading = document.querySelector('#loading');
const error = document.querySelector('#error');
const content = document.querySelector('#result-content');

const money = (value, currency = 'BRL') => new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value);
const domain = (store = '') => store.replace(/^www\./, '');
const reliabilityLabel = { alta: 'Loja bem avaliada', media: 'Avaliação moderada', baixa: 'Atenção à reputação', desconhecida: 'Sem avaliação disponível' };

function offerCard(offer) {
  const level = offer.reliability?.level || 'desconhecida';
  const store = domain(offer.store || new URL(offer.source).hostname);
  const initials = store.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
  return `<article class="offer">
    <div class="offer-name"><span class="store-avatar">${initials}</span><div><div class="store-name">${store}</div><div class="reliability ${level}"><i></i>${reliabilityLabel[level] || reliabilityLabel.desconhecida}</div></div></div>
    <div class="offer-price"><strong>${offer.price != null ? money(offer.price, offer.currency) : 'Consulte'}</strong><span>Preço encontrado</span></div>
    <a class="offer-link" href="${offer.source}" target="_blank" rel="noopener noreferrer">Ver oferta ↗</a>
  </article>`;
}

function showResults(data) {
  const offers = data.offers || [];
  document.querySelector('#product-name').textContent = data.original?.name || 'Ofertas para o produto';
  document.querySelector('#offer-count').textContent = `${offers.length} ${offers.length === 1 ? 'oferta' : 'ofertas'}`;
  const cheapest = data.cheapest;
  const reliable = data.cheapestReliable;
  document.querySelector('#highlights').innerHTML = `
    <div class="highlight"><span class="highlight-icon">↓</span><div><p>MELHOR PREÇO</p><strong>${cheapest ? money(cheapest.price, cheapest.currency) : 'Não encontrado'}</strong>${cheapest ? `<a href="${cheapest.source}" target="_blank" rel="noopener noreferrer">na ${domain(cheapest.store)} ↗</a>` : ''}</div></div>
    <div class="highlight secondary"><span class="highlight-icon">✓</span><div><p>MELHOR OPÇÃO CONFIÁVEL</p><strong>${reliable ? money(reliable.price, reliable.currency) : 'Não encontrada'}</strong>${reliable ? `<a href="${reliable.source}" target="_blank" rel="noopener noreferrer">na ${domain(reliable.store)} ↗</a>` : ''}</div></div>`;
  document.querySelector('#offers-list').innerHTML = offers.map(offerCard).join('');
}

function setState(state, message = '') {
  results.hidden = false; loading.hidden = state !== 'loading'; error.hidden = state !== 'error'; content.hidden = state !== 'results';
  if (state === 'error') error.textContent = message;
  searchButton.disabled = state === 'loading';
  searchButton.querySelector('span').textContent = state === 'loading' ? 'Pesquisando...' : 'Pesquisar preços';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  setState('loading');
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const response = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível pesquisar este produto.');
    showResults(data); setState('results');
  } catch (err) { setState('error', err.message || 'Ocorreu um erro ao buscar as ofertas. Tente novamente.'); }
});
