// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: red; icon-glyph: key;

// Setup seguro para el widget "Libros 2026".
// El token se ingresa al ejecutar y solo se guarda en Keychain.

const form = new Alert();
form.title = "Configurar Libros 2026";
form.addSecureTextField("Token de Notion");
form.addAction("Guardar");
form.addCancelAction("Cancelar");

if (await form.presentAlert() !== -1) {
  const token = form.textFieldValue(0).trim();
  const result = new Alert();

  if (!token) {
    result.title = "Falta el token";
    result.message = "Ingresa el token y vuelve a ejecutar el script.";
  } else {
    Keychain.set("NOTION_TOKEN", token);
    result.title = "Listo";
    result.message = "Token guardado en Keychain.";
  }
  result.addAction("OK");
  await result.presentAlert();
}

Script.complete();
