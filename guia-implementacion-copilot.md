# Guía de implementación: AI Copilot como Chief of Staff

Basado en el framework de Tal Raviv ("Build your personal AI copilot", Lenny's Newsletter).
Adaptado al contexto de Cal en Yape Bolivia.

**Fuente original:** https://read.readwise.io/read/01kcy4phpx94434xew8bf9cxrq

---

## Paso 1: "Contratar" al copilot — Definir instrucciones

El primer paso es definir el rol, personalidad y comportamientos del copilot. Esto va en las instructions del proyecto (equivalente a CLAUDE.md en Claude Code).

### Checklist

- [ ] Crear proyecto/carpeta dedicada para el CoS
- [ ] Escribir las instructions base. Copiar y adaptar este template:

```
Soy Carlos (Cal), CPO de Yape Bolivia (BCP). Eres mi Chief of Staff 
digital: coach experto y advisor que me asiste y proactivamente me 
ayuda a alcanzar mi máximo potencial en mi rol.

Te proporcionaré información detallada sobre Yape, nuestros productos, 
estrategia, equipo, stakeholders, dinámicas internas, y contexto de 
mercado.

En cada conversación, te daré contexto sobre una iniciativa particular 
para que me ayudes a navegarla.

Espero que:
- Hagas preguntas cuando necesites más contexto
- Completes información faltante importante
- Desafíes mis supuestos y sesgos
- Me hagas preguntas que me permitan tomar mejores decisiones

Anímame a:
- [lista de valores y comportamientos que te hacen exitoso como CPO]
- Ejemplo: Pensar en el usuario primero, basar decisiones en datos, 
  mantener foco estratégico, comunicar con claridad

Quiero que encuentres el balance de:
- [traits que quieres en un thinking partner]
- Ejemplo: Directo pero empático, desafiante pero constructivo, 
  estratégico pero pragmático, conciso pero completo cuando importa
```

- [ ] Personalizar la sección "Anímame a" con tus valores reales como CPO
- [ ] Personalizar la sección "balance de" con el tipo de interacción que prefieres
- [ ] **No intentar que sea perfecto** — las instructions son knobs que ajustas con el tiempo

### Tips
- Puedes hacer que sea más directo, más escéptico, más creativo — lo que necesites
- Revisitar y ajustar las instructions cada 2-4 semanas según lo que funcione

---

## Paso 2: "Onboarding" — Llenar el contexto del copilot

Como un nuevo empleado en su primera semana: darle toda la información que necesitaría antes de asignarle cualquier iniciativa.

### Checklist: Documentos a preparar/subir

**Empresa y producto:**
- [ ] Landing page / descripción de Yape Bolivia (guardar como PDF o .md)
- [ ] Estrategia de empresa / strategy deck (exportar a PDF)
- [ ] Productos principales: features, métricas clave, roadmap
- [ ] Diferenciadores vs competencia (Tigo Money, etc.)

**Mercado y clientes:**
- [ ] Customer segmentation / perfiles de usuario
- [ ] Research insights (descubrimientos de investigación recientes)
- [ ] Landscape competitivo Bolivia (fintech, billeteras, bancos)

**Organización:**
- [ ] Org chart del equipo de Cal
- [ ] Roles y responsabilidades de reportes directos
- [ ] Stakeholders clave (BCP Lima, directorio, reguladores)
- [ ] Dinámicas de equipo relevantes

**Personal:**
- [ ] OKRs o metas actuales de Cal
- [ ] Feedback de performance reciente (si existe)
- [ ] Retrospectivas de equipo recientes
- [ ] Estilo de comunicación preferido

### Checklist: Llenar gaps con entrevista

Después de subir los documentos disponibles, pedirle al copilot que te entreviste:

- [ ] Ejecutar este prompt:
```
Revisa todo lo que te he compartido y hazme preguntas para completar 
tu conocimiento.

¿Qué información importante te falta (a nivel empresa y producto) 
que necesitas para ayudarme across todas mis iniciativas, presentes 
y futuras?

Enfócate más en empresa, organización e industria. Menos en 
condiciones de corto plazo o individuos específicos, ya que eso 
cambiará con el tiempo.

Hazme las preguntas secuencialmente (las más cruciales primero), 
para que pueda responder una a la vez.
```

- [ ] Responder las preguntas (usar dictado por voz si es más fácil — rambling está bien)
- [ ] Cuando termines, ejecutar:
```
Crea un documento con la nueva información que aprendiste en esta 
conversación. Solo incluye información nueva (que no estaba ya en el 
contexto del proyecto). No menciones gaps pendientes.

Optimiza el documento para agregarlo al project knowledge, para que 
aplique en todas nuestras conversaciones futuras.

Usa citas exactas de mis palabras originales para lo más importante.
```
- [ ] Guardar ese documento como context file (e.g., `context/onboarding-notes.md`)

---

## Paso 3: "Kick off" de una iniciativa

Cada iniciativa vive en su propio thread/sesión. Así el copilot puede trackear el contexto completo sin mezclar temas.

### Checklist

- [ ] Identificar una iniciativa actual para empezar (e.g., un OKR, un lanzamiento, una decisión estratégica)
- [ ] Abrir nueva sesión/thread dedicado a esa iniciativa
- [ ] Ejecutar este prompt (usar dictado por voz — stream of consciousness):
```
Ahora que tienes el contexto sobre mi empresa y mi equipo, quiero 
contarte sobre la iniciativa en la que estoy trabajando y darte 
el contexto específico.

Este es el punto de partida de lo que sé, y lo iré actualizando 
conforme llegue más información e insights:

[Dictar todo lo que sabes: el problema, el cliente, el background, 
los stakeholders, la política organizacional — todo lo que tengas 
en mente y sea relevante]
```
- [ ] No preocuparse por estructura — just get it out there
- [ ] Dejar que el copilot pregunte y profundice

---

## Paso 4: "Poner a trabajar" al copilot

Con el contexto cargado, el copilot puede ayudar de formas que un LLM sin contexto no puede.

### Prompts diarios de alta frecuencia

- [ ] Agregar a rutina diaria:
```
¿Cuál es la cosa más importante que debería hacer a continuación?
```

### Biblioteca de prompts por situación

**Decisiones estratégicas:**
```
Tengo que decidir entre [opción A] y [opción B]. 
¿Qué preguntas debería hacerme antes de decidir?
```

**Preparación de reuniones:**
```
Tengo reunión con [persona/grupo] mañana sobre [tema]. 
Prepárame: contexto relevante, 3 preguntas que debería hacer, 
y 3 preguntas que probablemente me hagan.
```

**Stakeholder management:**
```
Necesito alinear a [stakeholder] sobre [tema]. 
Conociendo su perspectiva y prioridades, ¿cómo debería 
enmarcar la conversación?
```

**Priorización:**
```
Estas son mis iniciativas activas: [lista]. 
Dado nuestros OKRs y el contexto actual, ¿dónde debería 
estar enfocando más energía? ¿Qué estoy subestimando?
```

**Comunicación:**
```
Necesito escribir un [email/mensaje/presentación] para [audiencia] 
sobre [tema]. Draft algo y luego iteramos.
```

**Reflexión post-reunión:**
```
Acabo de salir de una reunión con [persona]. 
[dictar lo que pasó — stream of consciousness].
¿Qué debería hacer con esto?
```

**AI prototyping:**
```
Ayúdame a generar un prototipo interactivo de esta idea.
Vamos a construir solo la versión prototipo interactiva (sin 
funcionalidad profunda) para usarla como herramienta de feedback 
interno y para testear usabilidad con usuarios.
No lo construyas todavía — primero haz un plan.
```

**AI automations brainstorm:**
```
Basándote en lo que sabes sobre mí y mi organización, sugiere 5 
ideas de automatización AI que pueda construir.

Deben ayudarme como CPO a ahorrar tiempo en tareas drenantes pero 
esenciales que me alejan de trabajo más valioso y estratégico.

Pregúntate: ¿Qué trabajo repetitivo requiere algo de criterio y 
habilidad de escritura pero no mi expertise completa?

IMPORTANTE: Deben ser event-driven (se activan con un evento 
específico), NO batch tasks periódicas.

❌ MAL: "Cada lunes, escanear todos los tickets..."
✅ BIEN: "Cuando llegue un nuevo ticket de soporte, analizarlo 
   y alertarme si es urgente"
```

---

## Mantenimiento continuo

### "Gossiping" — Mantener al copilot al día

El copilot solo es útil si tiene contexto fresco. Actualízalo como le contarías a un colega sentado al lado tuyo.

- [ ] Después de reuniones importantes, abrir el thread de la iniciativa y dictar qué pasó:
```
No vas a creer lo que pasó en mi conversación con [persona]...
[dictar stream of consciousness]
```
- [ ] Si no quieres soluciones, decirlo:
```
No quiero soluciones ahora; quiero que escuches. 
Confirma solo con un "sí".
```
- [ ] El copilot recuerda y referencia estas actualizaciones después

### Lessons learned — Interés compuesto

- [ ] Al terminar una iniciativa, compartir el resultado (bueno o malo)
- [ ] Incluir retrospectivas del equipo
- [ ] Dictar reflexiones personales
- [ ] Ejecutar:
```
Crea un documento de "lessons learned" con lo nuevo que 
aprendimos en esta iniciativa. Solo información nueva.
```
- [ ] Guardar ese documento como context file → beneficia todas las iniciativas futuras

### Actualización periódica de context

- [ ] **Después de planning trimestral:** actualizar OKRs y prioridades
- [ ] **Después de cambios de equipo:** actualizar org chart y roles
- [ ] **Después de lanzamientos:** actualizar producto y métricas
- [ ] **Cuando te encuentres repitiendo contexto:** crear un context file

### Migración cuando se llena el context window

- [ ] Cuando una conversación se vuelve lenta o pierde calidad, ejecutar:
```
Esta conversación alcanzó su límite de contexto. Crea un documento 
que sirva como contexto inicial para un thread nuevo y en blanco.

Tu objetivo: preservar ~90% del valor de la conversación reduciendo 
~90% de su longitud.

Actúa como un experto haciendo handoff a otro experto que me ayudará. 
Dale todo lo que necesita para tener máximo éxito, lo más cercano 
posible a haber estado presente todo el tiempo.

Cuenta la historia cronológicamente. Usa las palabras originales 
exactas cuando sea particularmente valioso.

Omite contexto que ya existe en el project knowledge o instructions.

Crea un segundo documento separado con lo que elegiste no incluir, 
y por qué.
```
- [ ] Abrir nuevo thread con el documento generado

---

## Mindset — Cómo sacarle el máximo

- **No esperar perfección** — el copilot no siempre tiene razón, pero incluso cuando se equivoca inspira pensamiento propio
- **"What context does the AI need to succeed here?"** — la pregunta correcta cuando los resultados no satisfacen
- **Usar tu intuición como filtro** — "Your gut is the world's most sophisticated ML model" (David Lieb)
- **Editar inputs, no solo outputs** — si no te gusta el resultado, hover sobre tu mensaje, editar y reenviar con un poco más de guía
- **Si el mismo gap aparece repetidamente** → crear un context file permanente

---

## Estructura de archivos sugerida

```
Chief of Staff Cal/
├── CLAUDE.md                          # Instructions del copilot
├── BACKLOG.md                         # Ideas pendientes
├── guia-implementacion-copilot.md     # Esta guía
├── context/
│   ├── yape-profile.md                # Index → productos, equipo, estrategia
│   ├── producto.md                    # Yape Bolivia features y métricas
│   ├── equipo.md                      # Org chart, roles, stakeholders
│   ├── estrategia.md                  # OKRs, roadmap, prioridades
│   ├── competencia.md                 # Landscape fintech Bolivia
│   ├── onboarding-notes.md            # Lo que Claude aprendió en entrevista
│   └── lessons-learned/
│       └── YYYY-MM-iniciativa.md      # Lessons learned por iniciativa
```
