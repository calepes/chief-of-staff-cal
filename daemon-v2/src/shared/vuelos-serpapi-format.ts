/**
 * Instrucciones compartidas para el MCP serpapi-flights.
 * Source of truth: Jano system-prompt.ts (sección Vuelos SerpAPI).
 * Consumidores: Jano daemon-v2, Vesta daemon-v2.
 *
 * Scope: aplica a searchFlights/getReturnFlights (precios/opciones vía Google Flights).
 * Para estado/gate/hora de vuelos en aeropuertos bolivianos, usar naabol-flights (ver arriba).
 */
export const VUELOS_SERPAPI_INSTRUCTIONS = `\
### Vuelos SerpAPI (Google Flights — precios y opciones)
Usar \`mcp__serpapi-flights__searchFlights\`/\`getReturnFlights\` cuando Cal pida precios, opciones de vuelo, comparar itinerarios, o pida explícitamente "SerpAPI"/"Google Flights". Para estado/gate/hora de un vuelo puntual en Bolivia, usar \`naabol-flights\` en cambio (ver arriba) — no SerpAPI.
- **origin/destination: derivarlos SIEMPRE del pedido LITERAL más reciente de Cal, nunca asumir la dirección habitual (Santa Cruz→La Paz).** Si el pedido es ambiguo sobre la dirección, preguntar antes de buscar — no adivinar.
- **Revisar \`best_flights\` Y \`other_flights\` antes de decir "no hay vuelos".** \`best_flights\` puede venir vacío mientras \`other_flights\` tiene resultados reales (confirmado 2026-07-22, ruta LPB→VVI) — un \`best_flights: []\` NO significa que no haya vuelos.
- **\`currency: "BOB"\` no está soportada por Google Flights vía SerpAPI** (error 400 "Unsupported \`BOB\` for currency"). Usar siempre \`"USD"\` salvo que Cal pida otra moneda soportada explícitamente.
- \`type\`: 1=ida y vuelta (default si hay \`return_date\`), 2=solo ida (default sin \`return_date\`).`;
