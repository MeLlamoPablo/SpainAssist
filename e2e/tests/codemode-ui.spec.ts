import { expect, type Page, test } from '@playwright/test';

/** "Mis trámites" in the web preview (mock data): docs/codemode.md, "UI redesign". */

// Use the cached full Chromium browser; never install an additional headless shell.
test.use({ channel: 'chromium', viewport: { width: 1280, height: 820 } });

async function open(page: Page, query: string): Promise<string[]> {
  const pageErrors: string[] = [];
  // Only the preview itself: no map tiles or other outside requests.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort();
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:5186/?${query}&freeze=1&lang=es`);
  return pageErrors;
}

test('questions above procedure rows, not tied to them, and a floating meter', async ({ page }) => {
  const pageErrors = await open(page, 'view=procedures');

  // The workflow's question sits above the rows, without a heading or a procedure label.
  const questions = page.getByTestId('for-you');
  await expect(questions.getByText('¿Dónde y cuándo quieres la cita?')).toBeVisible();
  await expect(page.getByText('Para ti', { exact: true })).toHaveCount(0);
  await expect(questions.getByRole('button', { name: 'Renovar el DNI' })).toHaveCount(0);

  // Rows: facts on the left; on the right what needs doing, and no pointer to questions.
  const dni = page.getByTestId('procedure-card-p-dni');
  await expect(dni.getByTestId('card-facts')).toContainText('Coste:');
  await expect(dni.getByTestId('card-next')).toContainText('Siguiente:');
  await expect(dni).not.toContainText('pregunta pendiente');
  await expect(dni.getByTestId('card-questions')).toHaveCount(0);

  // Its text can be copied (a reference number, the next step); its buttons' labels can't.
  const userSelect = (el: Element) => getComputedStyle(el).userSelect;
  expect(await dni.getByRole('heading', { level: 2 }).evaluate(userSelect)).toBe('text');
  expect(await dni.getByTestId('card-next').evaluate(userSelect)).toBe('text');
  expect(await dni.getByTestId('card-details').evaluate(userSelect)).toBe('none');

  // A finished procedure: its pill, what is still missing, the rest in a popover.
  const fnmt = page.getByTestId('procedure-card-p-fnmt');
  await expect(fnmt.getByText('Completado')).toBeVisible();
  await expect(fnmt.getByTestId('card-missing')).toContainText(
    'Copia de seguridad del certificado',
  );
  await fnmt.getByTestId('card-more-requirements').click();
  await expect(page.getByRole('dialog').getByText('Tu DNI')).toBeVisible();
  await page.keyboard.press('Escape');

  // "Detalles" folds the plan, documents and sources.
  await expect(fnmt.getByTestId('card-plan')).toHaveCount(0);
  await fnmt.getByTestId('card-details').click();
  const details = fnmt.getByTestId('card-plan');
  await expect(details.getByTestId('card-steps')).toContainText('Solicitar el certificado');
  await expect(details.getByText('Fuentes oficiales')).toBeVisible();

  // The meter floats at the bottom with a stop button per agent.
  const meter = page.getByTestId('agent-meter');
  await expect(meter).toBeVisible();
  await expect(meter.getByRole('button', { name: 'Detener' }).first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});
