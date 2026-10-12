/* Page behaviour of the mock sede: cookie banner, session expiry warning, confirmations,
 * Cl@ve Móvil countdown/polling and the "No soy un robot" widget. */
(() => {
  const $ = (id) => document.getElementById(id);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // --- Cookie banner ------------------------------------------------------------------------
  const cookieForm = document.querySelector('[data-cookies-form]');
  if (cookieForm) {
    cookieForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const decision = event.submitter?.value === 'aceptadas' ? 'aceptadas' : 'rechazadas';
      // Set client-side (like most banners) so it sticks even if the page navigates away.
      // biome-ignore lint/suspicious/noDocumentCookie: Simulates the cookie banner used by legacy sedes.
      document.cookie = `sede_cookies=${decision}; path=/; max-age=31536000; secure; samesite=lax`;
      $('aviso-cookies')?.remove();
    });
  }

  // --- Session expiry warning ---------------------------------------------------------------
  const timeout = Number(document.body.dataset.sessionTimeout || 0);
  const warning = Number(document.body.dataset.sessionWarning || 0);
  const dialog = $('aviso-sesion');
  if (timeout > 0 && dialog) {
    let expiresAt = Date.now() + timeout * 1000;
    const tick = setInterval(() => {
      const left = Math.round((expiresAt - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(tick);
        window.location.href = '/sesion-caducada';
        return;
      }
      if (left <= warning) {
        if (dialog.hidden) {
          dialog.hidden = false;
          $('sesion-continuar').focus();
        }
        $('sesion-cuenta').textContent = mmss(left);
      }
    }, 1000);
    $('sesion-continuar').addEventListener('click', () => {
      fetch('/sesion/renovar', { method: 'POST', headers: { 'x-requested-with': 'fetch' } }).then(
        (res) => {
          if (!res.ok) {
            window.location.href = '/sesion-caducada';
            return;
          }
          expiresAt = Date.now() + timeout * 1000;
          dialog.hidden = true;
        },
      );
    });
  }

  // --- "Are you sure?" confirmations --------------------------------------------------------
  for (const form of document.querySelectorAll('form[data-confirm]')) {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  }

  // --- Cl@ve Móvil ------------------------------------------------------------------------------
  const movil = $('movil');
  if (movil) {
    let seconds = Number(movil.dataset.segundos || 0);
    let done = movil.dataset.estado !== 'pending';
    const status = $('movil-estado');
    const finish = (message) => {
      done = true;
      status.textContent = message;
      $('movil-completar').hidden = true;
      $('movil-nuevo').hidden = false;
    };
    const countdown = setInterval(() => {
      if (done) {
        clearInterval(countdown);
        return;
      }
      seconds = Math.max(0, seconds - 1);
      $('movil-cuenta').textContent = mmss(seconds);
      if (seconds === 0)
        finish('El tiempo para confirmar el acceso ha terminado. Genera un código nuevo.');
    }, 1000);
    const poll = () => {
      if (done) return;
      fetch(movil.dataset.estadoUrl, { headers: { accept: 'application/json' } })
        .then((res) => res.json())
        .then((data) => {
          if (done) return;
          if (data.status === 'approved') {
            done = true;
            status.textContent = 'Acceso confirmado. Volviendo a la sede…';
            $('movil-completar').submit();
          } else if (data.status === 'rejected') {
            finish('Has rechazado el acceso en la app.');
          } else if (data.status === 'expired') {
            finish('El código ha caducado. Genera uno nuevo.');
          } else {
            setTimeout(poll, 1500);
          }
        })
        .catch(() => setTimeout(poll, 3000));
    };
    if (!done) setTimeout(poll, 1500);
  }

  // --- "No soy un robot" ----------------------------------------------------------------------
  const captcha = $('captcha');
  if (captcha) {
    const box = $('no-robot');
    const challenge = $('captcha-reto');
    const grid = $('captcha-rejilla');
    const error = $('captcha-error');
    const status = $('captcha-estado');
    let solved = captcha.dataset.resuelto === 'si';
    const markSolved = () => {
      solved = true;
      box.checked = true;
      box.disabled = true;
      challenge.hidden = true;
      status.textContent = 'Verificación completada.';
    };
    const showChallenge = (data) => {
      box.checked = false;
      challenge.hidden = false;
      $('captcha-instruccion').textContent = data.instruction;
      error.hidden = !data.error;
      error.textContent = data.error || '';
      grid.replaceChildren(
        ...data.tiles.map((svg, i) => {
          const tile = document.createElement('button');
          tile.type = 'button';
          tile.className = 'captcha-imagen';
          tile.setAttribute('aria-pressed', 'false');
          tile.setAttribute('aria-label', `Imagen ${i + 1}`);
          tile.innerHTML = svg;
          tile.addEventListener('click', () => {
            const pressed = tile.getAttribute('aria-pressed') === 'true';
            tile.setAttribute('aria-pressed', pressed ? 'false' : 'true');
          });
          return tile;
        }),
      );
    };
    const post = (url, payload) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((res) => res.json());
    const handle = (data) => {
      if (data.status === 'solved') markSolved();
      else if (data.status === 'challenge') showChallenge(data);
    };
    box.addEventListener('change', () => {
      if (solved || !box.checked) return;
      status.textContent = 'Comprobando…';
      post('/verificacion/casilla', { webdriver: navigator.webdriver === true }).then((data) => {
        status.textContent = '';
        handle(data);
      });
    });
    $('captcha-verificar').addEventListener('click', () => {
      const selected = [...grid.children]
        .map((tile, i) => (tile.getAttribute('aria-pressed') === 'true' ? i : -1))
        .filter((i) => i >= 0);
      post('/verificacion/imagenes', { selected }).then(handle);
    });
    const poll = () => {
      if (solved) return;
      fetch('/verificacion/estado')
        .then((res) => res.json())
        .then((data) => {
          if (data.solved) markSolved();
          else setTimeout(poll, 1500);
        })
        .catch(() => setTimeout(poll, 3000));
    };
    setTimeout(poll, 1500);
  }
})();
