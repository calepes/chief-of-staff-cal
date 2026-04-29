const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionEnv {
  notionToken: string;
}

export async function setTaskStatus(env: NotionEnv, pageId: string, status: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${env.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        Estado: { status: { name: status } },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion setTaskStatus ${pageId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

export async function setTaskDateToday(env: NotionEnv, pageId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${env.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        Fecha: { date: { start: today } },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion setTaskDateToday ${pageId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
