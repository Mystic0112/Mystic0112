// Gera assets/generated/{contrib-wave,stats}.svg a partir da GraphQL API do GitHub.
// Sem dependências: Node 20+ (fetch nativo). Uso: GITHUB_TOKEN=... node scripts/generate-profile-assets.mjs
// Autoteste do cálculo de streak: node scripts/generate-profile-assets.mjs --check
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const LOGIN = process.env.PROFILE_LOGIN ?? 'Mystic0112';
const OUT_DIR = new URL('../assets/generated/', import.meta.url);

const C = { bg: '#0d1117', panel: '#161b22', border: '#30363d', text: '#e6edf3', muted: '#9198a1', soft: '#b1bac4', red: '#ff4b3e' };
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const LEVELS = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE'];

const QUERY = `query($login:String!){user(login:$login){
  contributionsCollection{ restrictedContributionsCount contributionCalendar{ totalContributions
    weeks{ contributionDays{ date contributionCount contributionLevel } } } }
  publicRepos: repositories(privacy:PUBLIC, ownerAffiliations:OWNER){ totalCount }
  ownedRepos: repositories(first:100, privacy:PUBLIC, ownerAffiliations:OWNER, isFork:false){
    nodes{ stargazerCount languages(first:20, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name } } } } } } }`;

async function fetchUser(token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': LOGIN },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data?.user) throw new Error(`GraphQL falhou (${res.status}): ${JSON.stringify(json.errors ?? json)}`);
  return json.data.user;
}

// ---------- cálculo (puro) ----------

/** days: [{date, contributionCount}] em ordem cronológica. Hoje sem contribuição não quebra a sequência. */
export function streaks(days) {
  let longest = 0, run = 0;
  for (const d of days) { run = d.contributionCount > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].contributionCount > 0) { current++; i--; }
  return { current, longest };
}

export function summarize(user) {
  const cal = user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays);
  const bytes = new Map();
  let stars = 0;
  for (const repo of user.ownedRepos.nodes) {
    stars += repo.stargazerCount;
    for (const { size, node } of repo.languages.edges) bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
  }
  const totalBytes = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const langs = [...bytes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, size]) => ({ name, pct: (size / totalBytes) * 100 }));
  return { total: cal.totalContributions, ...streaks(days), repos: user.publicRepos.totalCount, stars, langs };
}

// ---------- render (puro) ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => n.toLocaleString('pt-BR');

function mix(a, b, t) {
  const ch = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('');
}
// Escala sólida (sem degradê): vermelho misturado ao fundo do painel em passos fixos.
const LEVEL_FILL = [C.panel, mix(C.panel, C.red, 0.3), mix(C.panel, C.red, 0.55), mix(C.panel, C.red, 0.78), C.red];

const BASE_CSS = `.sans{font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace}
@keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.up{animation:up .6s cubic-bezier(.2,.8,.2,1) backwards}
.bar{transform-box:fill-box;transform-origin:left;animation:grow .9s cubic-bezier(.2,.8,.2,1) backwards}`;
const REDUCED = '@media (prefers-reduced-motion:reduce){*{animation:none!important}}';

function frame(w, h, title, desc, css, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d"><title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc><style>
${BASE_CSS}
${css}
${REDUCED}
</style><rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="14" fill="${C.bg}" stroke="${C.border}"/>
<rect class="bar" x="28" y="0" width="48" height="4" fill="${C.red}"/>
${body}
</svg>
`;
}

const label = (x, y, text, { size = 13, cls = 'mono' } = {}) => `<text class="${cls}" x="${x}" y="${y}" font-size="${size}" letter-spacing="2" fill="${C.muted}">${esc(text)}</text>`;

export function renderContribWave({ total, weeks }) {
  const W = 900, H = 252, X0 = 70, Y0 = 96, P = 15, S = 12;
  const cells = [], months = [];
  let lastMonth = -1, lastLabelWeek = -9;
  weeks.forEach((week, w) => {
    for (const day of week.contributionDays) {
      const d = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const lvl = Math.max(0, LEVELS.indexOf(day.contributionLevel));
      // Onda: frente diagonal (semana + dia) ondulada por uma senoide ao longo das semanas.
      const delay = 0.25 + w * 0.024 + d * 0.035 + 0.12 * Math.sin(w / 3.2);
      const stroke = lvl === 0 ? ` stroke="${C.border}" stroke-width=".6"` : '';
      cells.push(`<rect class="c" x="${X0 + w * P}" y="${Y0 + d * P}" width="${S}" height="${S}" rx="2.5" fill="${LEVEL_FILL[lvl]}"${stroke} style="animation-delay:${delay.toFixed(3)}s"/>`);
    }
    const m = new Date(`${week.contributionDays[0].date}T00:00:00Z`).getUTCMonth();
    if (m !== lastMonth) {
      if (w - lastLabelWeek >= 3 && w < weeks.length - 2) { months.push(label(X0 + w * P, Y0 - 12, MONTHS[m], { size: 11 })); lastLabelWeek = w; }
      lastMonth = m;
    }
  });
  const dayLabels = [[1, 'SEG'], [3, 'QUA'], [5, 'SEX']].map(([d, t]) => `<text class="mono" x="28" y="${Y0 + d * P + 10}" font-size="11" letter-spacing="1" fill="${C.muted}">${t}</text>`);
  const legendX = W - 28 - 34 - 5 * P; // caixas entre "MENOS" e "MAIS", alinhadas à direita
  const legend = LEVEL_FILL.map((f, i) => `<rect x="${legendX + i * P}" y="${H - 38}" width="${S}" height="${S}" rx="2.5" fill="${f}"${i === 0 ? ` stroke="${C.border}" stroke-width=".6"` : ''}/>`).join('');
  const css = `@keyframes wave{0%{opacity:0;transform:scale(.2)}60%{opacity:1;transform:scale(1.3)}100%{opacity:1;transform:scale(1)}}
.c{transform-box:fill-box;transform-origin:center;animation:wave .55s cubic-bezier(.2,.8,.2,1) backwards}`;
  const body = `${label(28, 40, 'CONTRIBUIÇÕES  /  ÚLTIMOS 12 MESES', { cls: 'mono up' })}
<text class="sans up" x="${W - 28}" y="44" text-anchor="end" font-size="26" font-weight="800" fill="${C.text}" style="animation-delay:.1s">${fmt(total)}<tspan class="mono" font-size="13" font-weight="400" letter-spacing="2" fill="${C.muted}" dx="10">CONTRIBUIÇÕES</tspan></text>
${months.join('')}
${dayLabels.join('')}
${cells.join('\n')}
<text class="mono" x="${legendX - 8}" y="${H - 28}" text-anchor="end" font-size="11" letter-spacing="1" fill="${C.muted}">MENOS</text>${legend}<text class="mono" x="${W - 28}" y="${H - 28}" text-anchor="end" font-size="11" letter-spacing="1" fill="${C.muted}">MAIS</text>`;
  return frame(W, H, 'Contribuições no GitHub', `Grade de contribuições dos últimos 12 meses: ${total} contribuições.`, css, body);
}

export function renderStats({ total, current, longest, repos, stars, langs }) {
  const W = 900, H = 286, dayWord = (n) => (n === 1 ? 'dia' : 'dias');
  const metric = (x, y, value, unit, name, delay) => `<g class="up" style="animation-delay:${delay}s"><text class="sans" x="${x}" y="${y}" font-size="38" font-weight="800" fill="${C.text}">${esc(value)}${unit ? `<tspan font-size="17" font-weight="600" fill="${C.muted}" dx="8">${esc(unit)}</tspan>` : ''}</text>${label(x, y + 26, name)}</g>`;
  const left = [
    metric(28, 100, fmt(total), '', 'CONTRIBUIÇÕES NO ANO', 0.1),
    metric(250, 100, fmt(current), dayWord(current), 'STREAK ATUAL', 0.18),
    metric(28, 190, fmt(longest), dayWord(longest), 'MAIOR STREAK', 0.26),
    metric(250, 190, fmt(repos), '', 'REPOS PÚBLICOS', 0.34),
  ].join('');
  const starsBlock = `<g class="up" style="animation-delay:.42s"><text class="sans" x="28" y="${H - 30}" font-size="15" fill="${C.soft}"><tspan fill="${C.red}">★</tspan> ${fmt(stars)} ${stars === 1 ? 'estrela recebida' : 'estrelas recebidas'} nos repositórios públicos</text></g>`;
  const LX = 486, BW = W - 28 - LX, top = langs[0]?.pct || 1;
  const bars = langs.map(({ name, pct }, i) => {
    const y = 74 + i * 36, d = (0.3 + i * 0.08).toFixed(2);
    return `<text class="mono up" x="${LX}" y="${y}" font-size="14" fill="${i === 0 ? C.red : C.text}" style="animation-delay:${d}s">${esc(name)}</text><text class="mono up" x="${W - 28}" y="${y}" text-anchor="end" font-size="13" fill="${C.muted}" style="animation-delay:${d}s">${pct.toFixed(1)}%</text>`
      + `<rect x="${LX}" y="${y + 8}" width="${BW}" height="6" rx="3" fill="${C.panel}"/><rect class="bar" x="${LX}" y="${y + 8}" width="${Math.max(6, (pct / top) * BW).toFixed(1)}" height="6" rx="3" fill="${i === 0 ? C.red : mix(C.panel, C.red, 0.55)}" style="animation-delay:${d}s"/>`;
  }).join('');
  const body = `${label(28, 40, 'ESTATÍSTICAS  /  GITHUB', { cls: 'mono up' })}
${left}
<line x1="452" y1="28" x2="452" y2="${H - 28}" stroke="${C.border}"/>
${label(LX, 40, 'LINGUAGENS  /  POR BYTES')}
${bars}
${starsBlock}`;
  const langDesc = langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ');
  return frame(W, H, 'Estatísticas do GitHub', `${total} contribuições no ano, streak atual de ${current} ${dayWord(current)}, maior streak de ${longest} ${dayWord(longest)}, ${repos} repositórios públicos, ${stars} estrelas. Linguagens por bytes: ${langDesc}.`, '', body);
}

// ---------- execução ----------

if (process.argv.includes('--check')) {
  const days = (counts) => counts.map((c) => ({ contributionCount: c }));
  assert.deepEqual(streaks(days([1, 1, 0, 1, 1, 1, 0])), { current: 3, longest: 3 }); // hoje vazio não zera
  assert.deepEqual(streaks(days([1, 0, 1, 1])), { current: 2, longest: 2 });
  assert.deepEqual(streaks(days([1, 1, 1, 0, 0])), { current: 0, longest: 3 });
  assert.deepEqual(streaks([]), { current: 0, longest: 0 });
  console.log('ok');
} else {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('Defina GITHUB_TOKEN (ou GH_TOKEN).');
  const user = await fetchUser(token);
  const stats = summarize(user);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('contrib-wave.svg', OUT_DIR), renderContribWave({ total: stats.total, weeks: user.contributionsCollection.contributionCalendar.weeks }));
  await writeFile(new URL('stats.svg', OUT_DIR), renderStats(stats));
  console.log(JSON.stringify({ ...stats, restricted: user.contributionsCollection.restrictedContributionsCount }));
}
