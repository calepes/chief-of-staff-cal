import { readFileSync, writeFileSync } from "node:fs";

const RSS_SOURCES_PATH =
  "/Users/calepes/Claude Projects/Personal/Apps/Digest/digest-project/src/rss-sources.js";

export type DigestSection = "bolivia" | "peru" | "colombia" | "fintech";

export interface AddDigestSourceResult {
  ok: boolean;
  entry: string;
  message: string;
}

export function addDigestSource(params: {
  feedUrl: string;
  feedName: string;
  section: DigestSection;
  weight?: number;
}): AddDigestSourceResult {
  const { feedUrl, feedName, section, weight = 0.8 } = params;

  if (weight < 0.5 || weight > 1.0) {
    throw new Error(`weight debe estar entre 0.5 y 1.0 (recibido: ${weight})`);
  }

  const content = readFileSync(RSS_SOURCES_PATH, "utf8");

  // Check for duplicate URL
  if (content.includes(feedUrl)) {
    throw new Error(`La URL ya existe en rss-sources.js: ${feedUrl}`);
  }

  // Find section boundaries
  const sectionMarker = `  ${section}: [`;
  const startIdx = content.indexOf(sectionMarker);
  if (startIdx === -1) throw new Error(`Sección '${section}' no encontrada en rss-sources.js`);

  // Find closing ],  of this section (first occurrence after startIdx)
  const endIdx = content.indexOf("\n  ],", startIdx);
  if (endIdx === -1) throw new Error(`No se encontró el cierre de la sección '${section}'`);

  const beforeSection = content.slice(0, startIdx);
  const sectionContent = content.slice(startIdx, endIdx);
  const afterSection = content.slice(endIdx);

  // Parse existing entries to find insertion point (sorted desc by weight)
  const lines = sectionContent.split("\n");
  let insertAfterLine = 0; // default: after opening line

  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/weight:\s*([\d.]+)/);
    if (m && parseFloat(m[1]) >= weight) {
      insertAfterLine = i;
    }
  }

  const newEntry = `    { name: '${feedName}', url: '${feedUrl}', weight: ${weight.toFixed(1)} },`;
  lines.splice(insertAfterLine + 1, 0, newEntry);

  writeFileSync(
    RSS_SOURCES_PATH,
    beforeSection + lines.join("\n") + afterSection,
    "utf8",
  );

  return {
    ok: true,
    entry: newEntry.trim(),
    message: `Fuente '${feedName}' agregada a sección '${section}' con weight ${weight.toFixed(1)}. Para que tome efecto en producción: wrangler deploy src/generator.js`,
  };
}
