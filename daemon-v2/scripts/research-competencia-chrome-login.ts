import { createInterface } from "node:readline/promises";
import { openResearchBrowserSession } from "../src/tools/research-competencia-browser.js";

/**
 * Setup ÚNICO (o cada vez que la sesión expire), a mano: abre el perfil de Chrome dedicado del
 * research de competencia (`~/.cos-agent/research-competencia-chrome-profile`) con ventana
 * VISIBLE (`headless:false`, a diferencia de las corridas reales) para que Cal se loguee en
 * Instagram/Facebook/TikTok/X. La sesión queda persistida en el perfil — las corridas reales
 * (`research-competencia-now.ts`, headless) la reusan sin volver a pedir login.
 *
 * `npm run research:chrome-login` — corre en Terminal, sin `node-fda` (no lee ningún archivo
 * protegido por TCC, solo abre una ventana de Chrome normal).
 */
async function main(): Promise<void> {
  console.log("Abriendo Chrome (perfil dedicado del research de competencia)...");
  const session = await openResearchBrowserSession({ headless: false });

  const urls = [
    "https://www.instagram.com/accounts/login/",
    "https://www.facebook.com/login",
    "https://www.tiktok.com/login",
    "https://x.com/login",
  ];
  for (const url of urls) {
    const page = await session.context.newPage();
    await page.goto(url).catch((err) => console.log(`  ⚠️ No pude abrir ${url}: ${err}`));
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(
    "\nLogueate en las pestañas que abrió Chrome (no hace falta todas — con las que puedas alcanza).\n" +
      "Presioná Enter acá cuando termines...",
  );
  rl.close();

  await session.close();
  console.log("Listo — sesión guardada en el perfil. Las próximas corridas la reusan sin pedir login de nuevo.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
