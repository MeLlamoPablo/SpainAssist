import { describe, expect, it } from 'vitest';
import { chatgptLoginPages } from './login-pages';

describe('chatgptLoginPages', () => {
  const pages = chatgptLoginPages();

  it('tells the user, in Spanish, that ChatGPT is connected', () => {
    expect(pages.success).toContain('<html lang="es">');
    expect(pages.success).toContain('<h1>Listo</h1>');
    expect(pages.success).toContain('Has conectado ChatGPT.');
    expect(pages.success).toContain('Ya puedes cerrar esta ventana.');
    expect(pages.failure).toContain('<h1>No se pudo conectar</h1>');
    expect(pages.notFound).toContain('<h1>No encontrado</h1>');
  });

  it('is self-contained: fonts inline, no external resources', () => {
    for (const html of Object.values(pages)) {
      expect(html).toContain('url(data:font/woff2;base64,');
      expect(html).toContain('url(data:font/ttf;base64,');
      expect(html).not.toMatch(/(?:src|href)="https?:/);
      expect(html).not.toMatch(/url\(["']?https?:/);
    }
  });

  it('draws the onboarding gradient', () => {
    expect(pages.success).toContain("getContext('webgl2'");
    expect(pages.success).toContain('u_turbIter');
    expect(pages.success).toContain('--sa-surface:');
  });
});
