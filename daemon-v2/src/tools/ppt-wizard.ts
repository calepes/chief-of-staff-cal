import type { CfKv } from "../cf-kv.js";

const PPT_WIZ_TTL = 7200; // 2 horas

function wizKey(chatId: number): string {
  return `ppt-wiz:${chatId}`;
}

export interface PptScqa {
  s?: string; // Situación
  c?: string; // Complicación
  q?: string; // Pregunta central
  a?: string; // Answer / recomendación
}

export interface PptSlide {
  n: number;
  assertion: string;
  type: "Chart" | "Table" | "Subtitle" | "Framework" | "Visual";
  mensaje?: string;
  cuerpo?: string;
  pendiente?: string;
}

export interface PptWizardState {
  topic?: string;         // Tema / título tentativo del deck
  audience?: string;      // Audiencia: quiénes son, qué les importa, tiempo
  step: number;           // 1=SCQA, 2=Storyline, 3=Tipos, 4=Contenido, 5=Done
  scqa?: PptScqa;
  storyline?: string[];   // Assertions ordenadas
  slides?: PptSlide[];
  updatedAt: string;      // ISO timestamp
}

export async function pptWizardSaveImpl(
  kv: CfKv,
  chatId: number,
  patch: Partial<Omit<PptWizardState, "updatedAt">>,
): Promise<PptWizardState> {
  const existing = await kv.get<PptWizardState>(wizKey(chatId));
  const next: PptWizardState = {
    step: 1,
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(wizKey(chatId), next, PPT_WIZ_TTL);
  return next;
}

export async function pptWizardLoadImpl(
  kv: CfKv,
  chatId: number,
): Promise<PptWizardState | null> {
  return kv.get<PptWizardState>(wizKey(chatId));
}
