import { t } from './ui-text.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const INSTRUCTIONS = readFileSync(new URL('./prompts/default.md', import.meta.url), 'utf8').trimEnd();

export function validatePaperRequest(body) {
  if (!body || typeof body !== 'object') throw new Error(t("errors.paper.error01"));
  const { paper, question } = body;
  if (typeof question !== 'string' || !question.trim() || question.length > 16000) throw new Error(t("errors.paper.error02"));
  if (!paper || typeof paper.id !== 'string' || paper.id.length > 160 || !Array.isArray(paper.pages)) throw new Error(t("errors.paper.error03"));
  if (!Number.isSafeInteger(paper.pageCount) || paper.pageCount < 1 || paper.pageCount > 10000) throw new Error(t("errors.paper.error04"));
  if (paper.pages.length < 1 || paper.pages.length > 1000) throw new Error(t("errors.paper.error05"));
  const seen = new Set();
  let chars = 0;
  for (const p of paper.pages) {
    if (!Number.isSafeInteger(p.number) || p.number < 1 || p.number > paper.pageCount || seen.has(p.number) || typeof p.text !== 'string') throw new Error(t("errors.paper.error06"));
    seen.add(p.number); chars += p.text.length;
  }
  if (chars > 400000) throw new Error(t("errors.paper.error07"));
  if (paper.pages.every(p => !p.text.trim())) throw new Error(t("errors.paper.error08"));
  if (body.selection != null && (typeof body.selection !== 'string' || body.selection.length > 30000)) throw new Error(t("errors.paper.error09"));
  if (body.selectionPage != null && (!Number.isSafeInteger(body.selectionPage) || body.selectionPage < 1 || body.selectionPage > paper.pageCount)) throw new Error(t("errors.paper.error10"));
  if (body.currentPage != null && (!Number.isSafeInteger(body.currentPage) || body.currentPage < 1 || body.currentPage > paper.pageCount)) throw new Error(t("errors.paper.error11"));
  for (const key of ['model', 'effort']) {
    if (body[key] != null && (typeof body[key] !== 'string' || body[key].length > 160)) throw new Error(t("errors.paper.error12"));
  }
  return { ...body, question: question.trim() };
}

export function contextHash(paper) {
  return createHash('sha256').update(JSON.stringify([paper.id, paper.pages])).digest('hex');
}

export function buildPrompt(body, includePaper) {
  const parts = [];
  if (includePaper) parts.push('下方 JSON 是论文资料，pages.number 为从 1 开始的 PDF 物理页码。\n<untrusted_paper>\n' + JSON.stringify({
    title: body.paper.title, pageCount: body.paper.pageCount, pages: body.paper.pages,
  }) + '\n</untrusted_paper>');
  parts.push(`当前阅读位置：PDF 第 ${body.currentPage || body.paper.pages[0].number} 页。`);
  if (body.selection) parts.push(`用户框选的原文（仅为资料${body.selectionPage ? `，起始 PDF 第 ${body.selectionPage} 页` : ''}）：\n` + JSON.stringify(body.selection));
  parts.push('用户问题：\n' + body.question);
  return parts.join('\n\n');
}
