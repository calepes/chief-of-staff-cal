import { spawnSync } from "node:child_process";

const READWISE_BIN = "/Users/calepes/.npm-global/bin/readwise";

function callReadwise(command: string, extraArgs: string[]): unknown {
  const result = spawnSync(READWISE_BIN, [command, "--json", ...extraArgs], {
    encoding: "utf8",
    timeout: 30_000,
  });

  if (result.error) {
    return { error: `Spawn error: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const msg = (result.stderr?.trim() || result.stdout?.trim() || "Command failed").slice(0, 500);
    return { error: msg };
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { raw: result.stdout.trim().slice(0, 500) };
  }
}

// ── Reader: documents ──────────────────────────────────────────────────────────

export interface ReaderListParams {
  location?: "new" | "later" | "shortlist" | "archive" | "feed";
  category?: string;
  limit?: number;
  pageCursor?: string;
  id?: string;
  updatedAfter?: string;
  tag?: string;
  responseFields?: string;
}

export function readerListDocuments(p: ReaderListParams = {}) {
  const args: string[] = [];
  if (p.location)       args.push("--location", p.location);
  if (p.category)       args.push("--category", p.category);
  if (p.limit != null)  args.push("--limit", String(p.limit));
  if (p.pageCursor)     args.push("--page-cursor", p.pageCursor);
  if (p.id)             args.push("--id", p.id);
  if (p.updatedAfter)   args.push("--updated-after", p.updatedAfter);
  if (p.tag)            args.push("--tag", p.tag);
  if (p.responseFields) args.push("--response-fields", p.responseFields);
  return callReadwise("reader-list-documents", args);
}

export interface ReaderSearchParams {
  query: string;
  limit?: number;
  locationIn?: string[];
  categoryIn?: string;
  authorSearch?: string;
  titleSearch?: string;
  tagsSearch?: string;
  tagsIn?: string;
}

export function readerSearchDocuments(p: ReaderSearchParams) {
  const args = ["--query", p.query];
  if (p.limit != null)      args.push("--limit", String(p.limit));
  if (p.locationIn?.length) args.push("--location-in", JSON.stringify(p.locationIn));
  if (p.categoryIn)         args.push("--category-in", p.categoryIn);
  if (p.authorSearch)       args.push("--author-search", p.authorSearch);
  if (p.titleSearch)        args.push("--title-search", p.titleSearch);
  if (p.tagsSearch)         args.push("--tags-search", p.tagsSearch);
  if (p.tagsIn)             args.push("--tags-in", p.tagsIn);
  return callReadwise("reader-search-documents", args);
}

export function readerGetDocumentDetails(documentId: string) {
  return callReadwise("reader-get-document-details", ["--document-id", documentId]);
}

export interface ReaderCreateDocumentParams {
  url: string;
  title?: string;
  author?: string;
  summary?: string;
  tags?: string[];
  notes?: string;
  category?: string;
}

export function readerCreateDocument(p: ReaderCreateDocumentParams) {
  const args = ["--url", p.url];
  if (p.title)    args.push("--title", p.title);
  if (p.author)   args.push("--author", p.author);
  if (p.summary)  args.push("--summary", p.summary);
  if (p.tags?.length) args.push("--tags", JSON.stringify(p.tags));
  if (p.notes)    args.push("--notes", p.notes);
  if (p.category) args.push("--category", p.category);
  return callReadwise("reader-create-document", args);
}

export function readerMoveDocuments(documentIds: string[], location: string) {
  return callReadwise("reader-move-documents", [
    "--document-ids", JSON.stringify(documentIds),
    "--location", location,
  ]);
}

export function readerGetDocumentHighlights(documentId: string) {
  return callReadwise("reader-get-document-highlights", ["--document-id", documentId]);
}

export function readerAddTagsToDocument(documentId: string, tagNames: string[]) {
  return callReadwise("reader-add-tags-to-document", [
    "--document-id", documentId,
    "--tag-names", JSON.stringify(tagNames),
  ]);
}

export function readerRemoveTagsFromDocument(documentId: string, tagNames: string[]) {
  return callReadwise("reader-remove-tags-from-document", [
    "--document-id", documentId,
    "--tag-names", JSON.stringify(tagNames),
  ]);
}

export function readerBulkEditDocumentMetadata(documents: object[]) {
  return callReadwise("reader-bulk-edit-document-metadata", [
    "--documents", JSON.stringify(documents),
  ]);
}

export function readerListTags() {
  return callReadwise("reader-list-tags", []);
}

export function readerAddTagsToHighlight(
  documentId: string,
  highlightDocumentId: string,
  tagNames: string[],
) {
  return callReadwise("reader-add-tags-to-highlight", [
    "--document-id", documentId,
    "--highlight-document-id", highlightDocumentId,
    "--tag-names", JSON.stringify(tagNames),
  ]);
}

export function readerRemoveTagsFromHighlight(
  documentId: string,
  highlightDocumentId: string,
  tagNames: string[],
) {
  return callReadwise("reader-remove-tags-from-highlight", [
    "--document-id", documentId,
    "--highlight-document-id", highlightDocumentId,
    "--tag-names", JSON.stringify(tagNames),
  ]);
}

export function readerSetHighlightNotes(
  documentId: string,
  highlightDocumentId: string,
  notes: string | null,
) {
  const args = [
    "--document-id", documentId,
    "--highlight-document-id", highlightDocumentId,
  ];
  if (notes !== null) args.push("--notes", notes);
  return callReadwise("reader-set-highlight-notes", args);
}

export interface ReaderCreateHighlightParams {
  documentId: string;
  htmlContent: string;
  tags?: string[];
  note?: string;
}

export function readerCreateHighlight(p: ReaderCreateHighlightParams) {
  const args = [
    "--document-id", p.documentId,
    "--html-content", p.htmlContent,
  ];
  if (p.tags?.length) args.push("--tags", JSON.stringify(p.tags));
  if (p.note)         args.push("--note", p.note);
  return callReadwise("reader-create-highlight", args);
}

// ── Readwise classic highlights ────────────────────────────────────────────────

export interface ReadwiseSearchHighlightsParams {
  vectorSearchTerm: string;
  fullTextQueries?: string;
  limit?: number;
}

export function readwiseSearchHighlights(p: ReadwiseSearchHighlightsParams) {
  const args = ["--vector-search-term", p.vectorSearchTerm];
  if (p.fullTextQueries) args.push("--full-text-queries", p.fullTextQueries);
  if (p.limit != null)   args.push("--limit", String(p.limit));
  return callReadwise("readwise-search-highlights", args);
}

export interface ReadwiseListHighlightsParams {
  pageSize?: number;
  page?: number;
  bookId?: string;
  responseFields?: string;
}

export function readwiseListHighlights(p: ReadwiseListHighlightsParams = {}) {
  const args: string[] = [];
  if (p.pageSize != null) args.push("--page-size", String(p.pageSize));
  if (p.page != null)     args.push("--page", String(p.page));
  if (p.bookId)           args.push("--book-id", p.bookId);
  if (p.responseFields)   args.push("--response-fields", p.responseFields);
  return callReadwise("readwise-list-highlights", args);
}

export function readwiseGetDailyReview() {
  return callReadwise("readwise-get-daily-review", []);
}

export function readwiseCreateHighlights(highlights: object[]) {
  return callReadwise("readwise-create-highlights", [
    "--highlights", JSON.stringify(highlights),
  ]);
}

export interface ReadwiseUpdateHighlightParams {
  highlightId: number | string;
  text?: string;
  note?: string;
  color?: string;
  addTags?: string[];
  removeTags?: string[];
}

export function readwiseUpdateHighlight(p: ReadwiseUpdateHighlightParams) {
  const args = ["--highlight-id", String(p.highlightId)];
  if (p.text)             args.push("--text", p.text);
  if (p.note != null)     args.push("--note", p.note);
  if (p.color)            args.push("--color", p.color);
  if (p.addTags?.length)  args.push("--add-tags", JSON.stringify(p.addTags));
  if (p.removeTags?.length) args.push("--remove-tags", JSON.stringify(p.removeTags));
  return callReadwise("readwise-update-highlight", args);
}

export function readwiseDeleteHighlight(highlightId: number | string) {
  return callReadwise("readwise-delete-highlight", ["--highlight-id", String(highlightId)]);
}
