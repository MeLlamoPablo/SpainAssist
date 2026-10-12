import { z } from 'zod';

// The CSP has no 'unsafe-eval'. Without jitless, zod probes `new Function` and the browser
// reports a CSP violation. Zod reads this when it builds a schema, so main.tsx imports it first.
z.config({ jitless: true });
