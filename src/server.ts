// Full interactive viewer — port of f1-editorial-os's Stories tab
// (StoriesPanel.tsx + lib/stories.ts), running entirely on local data
// (article-store.ts, fia-store.ts) with server-rendered HTML forms instead
// of a client-side framework. No dependency on f1-editorial-os at runtime —
// every byte of logic and styling lives in this project.
//
// Port 3004: reserved for this project only (3000-3003 are already used by
// f1-editorial-os, f1-data, live-gp, prediction-weekend).

import { createServer, type IncomingMessage } from "node:http";
import { getArticleFullText } from "./article-fetcher";
import { synthesizeArticle, resolveProvider } from "./synthesis";
import { setSynthesis } from "./article-store";
import { listStories, ingestStories, type StoriesContent } from "./stories-data";
import { deriveSessionLabel, type WttsTeamSynthesis } from "./synthesis";

const PORT = 3004;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function badge(text: string): string {
  return `<span class="badge">${escapeHtml(text)}</span>`;
}

const SENTIMENT_LABEL: Record<string, string> = { positif: "Positif", neutre: "Neutre", "négatif": "Négatif" };

function sentimentBadge(sentiment: string | null): string {
  if (!sentiment || !(sentiment in SENTIMENT_LABEL)) return "";
  const cls = sentiment === "positif" ? "sentiment-pos" : sentiment === "négatif" ? "sentiment-neg" : "sentiment-neu";
  return `<span class="sentiment-badge ${cls}">${SENTIMENT_LABEL[sentiment]}</span>`;
}

// Verbatim quotes (lifted from quote marks in the source) get the classic
// guillemets treatment; paraphrases (the model summarizing unquoted
// reporting) get a plain dash so a reader never mistakes a paraphrase for
// the driver's actual words.
function renderQuote(q: { text: string; verbatim: boolean }): string {
  return q.verbatim
    ? `<p class="quote">&laquo;&nbsp;${escapeHtml(q.text)}&nbsp;&raquo;</p>`
    : `<p class="quote quote-paraphrase">&mdash; ${escapeHtml(q.text)}</p>`;
}

// "Leclerc : FP1 : P1 / FP2 : P2" — built here from the model's structured
// per-session {session, position} pairs rather than asked of the model as
// a summary sentence. A free-text "result" field was tried first and kept
// drifting (wrong language, or an unrelated example the model had copied
// verbatim) — formatting data the model already extracted correctly is
// deterministic and can't drift.
function sessionsLabel(sessions: { session: string; position: string }[]): string {
  return sessions.map((s) => `${s.session} : ${s.position}`).join(" / ");
}

function lastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

function renderResultLine(drivers: { driver: string; sessions: { session: string; position: string }[] }[]): string | null {
  const parts = drivers.filter((d) => d.sessions.length > 0).map((d) => `${lastName(d.driver)} : ${sessionsLabel(d.sessions)}`);
  return parts.length > 0 ? parts.join(" — ") : null;
}

function renderTeamSynthesis(teams: WttsTeamSynthesis[]): string {
  return `<div class="team-grid">${teams
    .map((t) => {
      const drivers = t.drivers
        .map((d) => {
          // "problem"/"incident"/"outlook" are model-extracted prose (can
          // run a full sentence or more), not short labels — a nowrap pill
          // badge here overflowed the page and squeezed "Lando Norris"
          // onto two lines. Each gets its own paragraph, same treatment as
          // the quote.
          const quotesHtml = d.quotes.map(renderQuote).join("");
          return `
          <li>
            <div class="driver-head">
              <span class="driver-name">${escapeHtml(d.driver)}</span>
              ${sentimentBadge(d.sentiment)}
            </div>
            ${quotesHtml}
            ${d.teammateComparison ? `<p class="meta-inline"><span class="meta-label">Vs coéquipier</span> ${escapeHtml(d.teammateComparison)}</p>` : ""}
            ${d.incident ? `<p class="problem"><span class="meta-label">Incident</span> ${escapeHtml(d.incident)}</p>` : ""}
            ${d.problem ? `<p class="problem"><span class="meta-label">Problème</span> ${escapeHtml(d.problem)}</p>` : ""}
            ${d.outlook ? `<p class="meta-inline"><span class="meta-label">À suivre</span> ${escapeHtml(d.outlook)}</p>` : ""}
          </li>`;
        })
        .join("");
      const staffHtml = t.staffQuotes
        .map(
          (s) => `
          <div class="staff-quote">
            <span class="staff-name">${escapeHtml(s.name)}${s.role ? ` <span class="staff-role">${escapeHtml(s.role)}</span>` : ""}</span>
            <p class="quote">&laquo;&nbsp;${escapeHtml(s.quote)}&nbsp;&raquo;</p>
          </div>`,
        )
        .join("");
      const resultLine = renderResultLine(t.drivers);
      return `
      <div class="team-card">
        <p class="team-name">${escapeHtml(t.teamName)}</p>
        ${t.context ? `<p class="context">${escapeHtml(t.context)}</p>` : ""}
        <ul class="driver-list">${drivers}</ul>
        ${staffHtml ? `<div class="staff-list">${staffHtml}</div>` : ""}
        ${t.upgrade ? `<p class="meta"><span class="meta-label">Évolution</span> ${escapeHtml(t.upgrade)}</p>` : ""}
        ${resultLine ? `<p class="meta"><span class="meta-label">Résultat</span> ${escapeHtml(resultLine)}</p>` : ""}
      </div>`;
    })
    .join("")}</div>`;
}

function renderLinkRow(title: string, url: string, meta?: string, badgeHtml?: string): string {
  return `
    <a class="link-row" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
      <div class="link-row-top">
        <span class="link-title">${escapeHtml(title)}</span>
        ${badgeHtml ?? ""}
      </div>
      ${meta ? `<span class="link-meta">${escapeHtml(meta)}</span>` : ""}
    </a>`;
}

function eventSelect(events: string[], selected: string | null): string {
  const options = events
    .map((e) => `<option value="${escapeHtml(e)}"${e === selected ? " selected" : ""}>${escapeHtml(e)}</option>`)
    .join("");
  const extra =
    selected && !events.includes(selected) ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>` : "";
  return `
    <form method="get" action="/" class="event-form">
      <select name="event" onchange="this.form.submit()">${extra}${options}</select>
    </form>`;
}

function renderPage(content: StoriesContent, refreshError: string | null): string {
  const eventQS = content.event ? `<input type="hidden" name="event" value="${escapeHtml(content.event)}">` : "";

  const quotesHtml =
    content.quotes.length > 0
      ? content.quotes
          .map((q) => {
            const session = deriveSessionLabel(q.title);
            const link = renderLinkRow(q.title, q.url, timeAgo(q.fetchedAt), session ? badge(session) : undefined);
            const synthesis = q.teamsSynthesis
              ? `<details class="synthesis-toggle">
                   <summary>Déplier le résumé par écurie (${q.teamsSynthesis.length})</summary>
                   ${renderTeamSynthesis(q.teamsSynthesis)}
                 </details>`
              : "";
            return `<div class="quote-block">${link}${synthesis}</div>`;
          })
          .join("")
      : `<p class="empty">Aucun article &laquo;&nbsp;What the teams said&nbsp;&raquo; trouvé pour ce Grand Prix. Utilise «&nbsp;Rafraîchir&nbsp;».</p>`;

  const transcriptsHtml =
    content.transcripts.length > 0
      ? content.transcripts.map((t) => renderLinkRow(t.title, t.url, timeAgo(t.publishedAt))).join("")
      : `<p class="empty">Aucune transcription FIA récupérée pour ce Grand Prix.</p>`;

  const documentsHtml =
    content.documents.length > 0
      ? content.documents
          .map((d) => renderLinkRow(d.title, d.url, timeAgo(d.publishedAt), d.isPenalty ? badge("Pénalité") : undefined))
          .join("")
      : `<p class="empty">Aucun document FIA récupéré pour ce Grand Prix.</p>`;

  const unsynthesizedCount = content.quotes.filter((q) => !q.teamsSynthesis).length;

  return page(`
    <div class="header-row">
      <div>
        <p class="section-title" style="margin:0">Déclarations pilotes/écuries, transcriptions FIA et documents officiels</p>
      </div>
      <div class="header-actions">
        ${content.events.length > 0 ? eventSelect(content.events, content.event) : ""}
        <form method="post" action="/refresh">
          ${eventQS}
          <button class="btn" type="submit">↺ Rafraîchir (F1.com + FIA)</button>
        </form>
      </div>
    </div>

    ${refreshError ? `<div class="error">${escapeHtml(refreshError)}</div>` : ""}

    <section class="section">
      <div class="section-header">
        <p class="section-title">Ce que les équipes ont dit — F1.com</p>
        ${
          content.event && unsynthesizedCount > 0
            ? `<form method="post" action="/synthesize">${eventQS}<button class="btn btn-accent" type="submit">✨ Générer les résumés (${unsynthesizedCount})</button></form>`
            : ""
        }
      </div>
      ${quotesHtml}
    </section>

    <section class="section">
      <p class="section-title">Conférences de presse FIA — pré/post course, qualifs</p>
      ${transcriptsHtml}
    </section>

    <section class="section">
      <p class="section-title">Documents officiels FIA — pénalités &amp; décisions</p>
      ${documentsHtml}
    </section>
  `);
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stories</title>
<style>
  :root {
    --background: #0b0b0f; --surface: #2a2018; --surface-2: #221a12; --surface-hover: #342a1e;
    --border: #3e2e22; --border-hover: #564030; --foreground: #ededed; --muted: #9a8f82;
    --accent: #e10600; --accent-soft: #ff4d47;
  }
  * { box-sizing: border-box; overflow-wrap: break-word; }
  html, body { margin: 0; padding: 0; background: var(--background); color: var(--foreground);
    font-family: -apple-system, "Segoe UI", Arial, sans-serif; overflow-x: hidden; }
  body { max-width: 760px; margin: 0 auto; padding: 24px 20px 80px; }
  a { text-decoration: none; color: inherit; }
  h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 4px; }
  h1 .brand { color: var(--accent); }
  .header-row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
  .header-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  select { background: var(--surface-2); color: var(--foreground); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 10px; font-size: 13px; }
  .btn { background: var(--surface-2); color: var(--foreground); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 12px; font-size: 13px; font-weight: 500; cursor: pointer; }
  .btn:hover { background: var(--border); }
  .btn-accent { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-accent:hover { background: var(--accent-soft); }
  .event-form, form { display: inline-block; margin: 0; }
  .error { border: 1px solid rgba(225,6,0,0.3); background: rgba(225,6,0,0.05); color: var(--accent-soft);
    border-radius: 12px; padding: 12px 16px; font-size: 13px; margin-bottom: 16px; }
  .section { margin: 28px 0; }
  .section-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
  .section-title { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 12px; }
  .link-row { display: block; border: 1px solid var(--border); background: var(--surface); border-radius: 12px;
    padding: 14px; margin-bottom: 8px; transition: transform .15s, border-color .15s, background .15s; }
  .link-row:hover { transform: translateY(-1px); border-color: var(--border-hover); background: var(--surface-hover); }
  .link-row-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .link-title { font-size: 14px; font-weight: 600; color: var(--foreground); }
  .link-meta { display: block; font-size: 11px; color: var(--muted); margin-top: 4px; }
  .quote-block { margin-bottom: 16px; }
  .synthesis-toggle { margin-top: 8px; }
  .synthesis-toggle summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--accent-soft);
    list-style: none; user-select: none; }
  .synthesis-toggle summary::-webkit-details-marker { display: none; }
  .synthesis-toggle summary::before { content: "▸ "; }
  .synthesis-toggle[open] summary::before { content: "▾ "; }
  .synthesis-toggle summary:hover { color: var(--foreground); }
  /* CSS columns instead of grid: team cards vary a lot in height (a
     driver with a long problem/quote vs. one with none), and a 2-column
     grid sizes every row to its tallest cell — leaving a big empty gap
     under a short card before the next row can start. Columns pack each
     card right under the previous one in the same column instead. */
  .team-grid { column-count: 1; column-gap: 12px; margin-top: 8px; }
  @media (min-width: 640px) { .team-grid { column-count: 2; } }
  .team-card { border: 1px solid var(--border); background: var(--surface); border-radius: 12px; padding: 14px;
    margin-bottom: 12px; break-inside: avoid; }
  .team-name { font-size: 13px; font-weight: 700; color: var(--foreground); margin: 0 0 8px; }
  .context { font-size: 12px; line-height: 1.55; color: var(--foreground); opacity: 0.85; margin: 0 0 12px;
    padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .driver-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .driver-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .driver-name { font-size: 12.5px; font-weight: 600; color: var(--foreground); }
  .position { font-weight: 400; color: var(--muted); }
  .quote { font-size: 12px; line-height: 1.5; color: var(--muted); font-style: italic; margin: 3px 0 0; }
  .quote-paraphrase { font-style: normal; }
  .problem { font-size: 12px; line-height: 1.5; color: var(--accent-soft); margin: 3px 0 0; }
  .meta-inline { font-size: 12px; line-height: 1.5; color: var(--muted); margin: 3px 0 0; }
  .badge { flex-shrink: 0; display: inline-flex; align-items: center; border-radius: 6px; padding: 2px 8px;
    font-size: 11px; font-weight: 500; background: rgba(225,6,0,0.15); color: var(--accent-soft); white-space: nowrap; }
  .sentiment-badge { flex-shrink: 0; display: inline-flex; align-items: center; border-radius: 6px; padding: 1px 7px;
    font-size: 10px; font-weight: 600; white-space: nowrap; }
  .sentiment-pos { background: rgba(60,180,90,0.15); color: #5fd189; }
  .sentiment-neu { background: rgba(154,143,130,0.15); color: var(--muted); }
  .sentiment-neg { background: rgba(225,6,0,0.15); color: var(--accent-soft); }
  .staff-list { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); display: flex;
    flex-direction: column; gap: 8px; }
  .staff-name { font-size: 12.5px; font-weight: 600; color: var(--foreground); }
  .staff-role { font-weight: 400; color: var(--muted); }
  .meta { font-size: 12px; color: var(--muted); margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--border); }
  .meta-label { color: var(--foreground); font-weight: 600; margin-right: 4px; }
  .empty { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<h1><a href="/"><span class="brand">F1</span> Stories</a></h1>
${body}
</body>
</html>`;
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
}

async function synthesizeUnsynthesized(event: string): Promise<void> {
  const content = await listStories(event);
  for (const q of content.quotes) {
    if (q.teamsSynthesis) continue;
    const text = await getArticleFullText(q.url);
    if (!text) continue;
    const teams = await synthesizeArticle(text, q.title);
    if (teams.length === 0) continue;
    setSynthesis(q.url, teams);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/") {
      const event = url.searchParams.get("event") ?? undefined;
      const content = await listStories(event);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPage(content, null));
      return;
    }

    if (req.method === "POST" && url.pathname === "/refresh") {
      const params = await readBody(req);
      const event = params.get("event") ?? undefined;
      const report = await ingestStories(event);
      res.writeHead(302, { Location: `/?event=${encodeURIComponent(report.event ?? event ?? "")}` });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/synthesize") {
      const params = await readBody(req);
      const event = params.get("event");
      if (event) await synthesizeUnsynthesized(event);
      res.writeHead(302, { Location: `/?event=${encodeURIComponent(event ?? "")}` });
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(e instanceof Error ? e.message : String(e));
  }
});

server.listen(PORT, () => {
  console.log(`Stories sur http://localhost:${PORT}`);
});
