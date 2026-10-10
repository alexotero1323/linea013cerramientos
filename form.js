/* Línea 013 · formulario "Cuéntanos tu proyecto".
   Valida en el navegador, conserva lo escrito si algo falla y solo confirma cuando
   el servidor responde que ha recibido la solicitud. La función que recibe el envío
   (action="/api/proyecto") se conecta al desplegar en Cloudflare; hasta entonces el
   envío falla de forma honesta y ofrece el correo directo. */
(function () {
  'use strict';

  var form = document.getElementById('form-proyecto');
  if (!form) return;
  var status = document.getElementById('form-status');
  var button = document.getElementById('form-enviar');
  var MAX_FILE = 10 * 1024 * 1024;
  var MAX_TOTAL = 25 * 1024 * 1024;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function fieldOf(input) { return input.closest('.field'); }
  function setError(input, id, message) {
    var el = document.getElementById(id);
    if (message) { el.textContent = message; el.hidden = false; fieldOf(input).classList.add('is-invalid'); input.setAttribute('aria-invalid', 'true'); }
    else { el.hidden = true; fieldOf(input).classList.remove('is-invalid'); input.removeAttribute('aria-invalid'); }
  }

  function validate() {
    var ok = true, first = null;
    var nombre = form.nombre, email = form.email, mensaje = form.mensaje, archivos = form.archivos, priv = form.privacidad;

    var e1 = nombre.value.trim() ? '' : 'Escribe tu nombre.';
    setError(nombre, 'e-nombre', e1); if (e1) { ok = false; first = first || nombre; }

    var e2 = EMAIL.test(email.value.trim()) ? '' : 'Escribe un correo electrónico válido.';
    setError(email, 'e-email', e2); if (e2) { ok = false; first = first || email; }

    var e3 = mensaje.value.trim() ? '' : 'Cuéntanos brevemente qué necesitas.';
    setError(mensaje, 'e-mensaje', e3); if (e3) { ok = false; first = first || mensaje; }

    var e4 = '', total = 0;
    Array.prototype.forEach.call(archivos.files, function (f) {
      total += f.size;
      if (f.size > MAX_FILE && !e4) e4 = 'El archivo "' + f.name + '" supera los 10 MB.';
    });
    if (!e4 && total > MAX_TOTAL) e4 = 'Los archivos suman más de 25 MB. Quita alguno o comprímelos.';
    setError(archivos, 'e-archivos', e4); if (e4) { ok = false; first = first || archivos; }

    var e5 = priv.checked ? '' : 'Necesitamos tu consentimiento para responderte.';
    setError(priv, 'e-privacidad', e5); if (e5) { ok = false; first = first || priv; }

    if (first) first.focus();
    return ok;
  }

  function say(text, kind, html) {
    status.className = 'form__status' + (kind ? ' is-' + kind : '');
    if (html) status.innerHTML = html; else status.textContent = text;
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    say('');
    if (form.web.value) return; // trampa para bots: se ignora en silencio
    if (!validate()) { say('Revisa los campos marcados.', 'error'); return; }

    button.disabled = true;
    say('Enviando…');
    var data = new FormData(form);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 60000);

    fetch(form.action, { method: 'POST', body: data, signal: ctrl.signal })
      .then(function (r) { return r.ok ? r.json().catch(function () { return {}; }) : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (res) {
        if (res && res.ok === false) throw new Error(res.error || 'rechazado');
        form.reset();
        say('Recibido. Hemos guardado tu proyecto y te responderemos en cuanto lo estudiemos.', 'ok');
      })
      .catch(function () {
        var asunto = encodeURIComponent('Proyecto · ' + (form.nombre.value.trim() || 'consulta'));
        say('', 'error',
          'No se ha podido enviar el formulario. Lo que has escrito sigue aquí: puedes volver a intentarlo ' +
          'o escribirnos directamente a <a class="link" href="mailto:cerramientoslinea013@gmail.com?subject=' + asunto + '">cerramientoslinea013@gmail.com</a> adjuntando tus archivos.');
      })
      .finally(function () { clearTimeout(timer); button.disabled = false; });
  });

  // Los errores se retiran en cuanto el campo se corrige.
  ['nombre', 'email', 'mensaje', 'archivos', 'privacidad'].forEach(function (name) {
    form[name].addEventListener('input', function () {
      var f = fieldOf(form[name]);
      if (f.classList.contains('is-invalid')) validate();
    });
  });
})();
