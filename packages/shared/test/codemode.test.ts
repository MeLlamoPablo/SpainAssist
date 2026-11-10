import { describe, expect, it } from 'vitest';
import { type UiNode, uiTreeAddresses, uiTreeProblem } from '../src/codemode';

const root = (...children: UiNode[]): UiNode => ({ type: 'Root', props: {}, children });

describe('interface trees from workflows', () => {
  it('accept native components with valid props', () => {
    expect(
      uiTreeProblem(
        root({
          type: 'Form',
          props: { title: '¿Cuánto ganaste?' },
          children: [
            {
              type: 'TextField',
              props: { label: 'Ingresos', value: '', onChange: { $handler: 'r.0#onChange' } },
              children: [],
            },
            {
              type: 'Actions',
              props: {},
              children: [{ type: 'Button', props: { type: 'primary' }, children: ['Seguir'] }],
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('refuse unknown components, bad props, non-https links and oversized trees, saying where', () => {
    expect(uiTreeProblem(root({ type: 'Script' as never, props: {}, children: [] }))).toMatch(
      /unknown component "Script"/,
    );
    expect(uiTreeProblem(root({ type: 'Choice', props: { options: [] }, children: [] }))).toMatch(
      /<Choice>: options/,
    );
    expect(
      uiTreeProblem(
        root({ type: 'Link', props: { href: 'javascript:alert(1)' }, children: ['x'] }),
      ),
    ).toMatch(/<Link>: href/);
    const appointment = (value: string) =>
      root({
        type: 'Appointment',
        props: { slots: ['2026-10-19T09:30'], value, onChange: { $handler: 'r.0#onChange' } },
        children: [],
      });
    expect(uiTreeProblem(appointment('mañana'))).toMatch(/<Appointment>: value must be one of/);
    expect(uiTreeProblem(appointment('2026-10-19T09:30'))).toBeNull();
    expect(uiTreeProblem(appointment('more'))).toBeNull();
    expect(uiTreeProblem(root({ type: 'Form', children: [] } as never))).toMatch(
      /<Form>: props must be an object/,
    );
    const map = (from: number) => ({
      type: 'Map' as const,
      props: {
        options: Array.from({ length: 30 }, (_, i) => ({
          value: `v${i}`,
          label: `L${i}`,
          address: `Calle ${from + i}, Madrid`,
        })),
        onChange: { $handler: 'r#onChange' },
      },
      children: [],
    });
    expect(uiTreeProblem(root(map(0), map(0)))).toBeNull();
    expect(uiTreeProblem(root(map(0), map(30)))).toMatch(/more than 50 places/);
    const wide = root(...Array.from({ length: 700 }, () => 'x'));
    expect(uiTreeProblem(wide)).toMatch(/more than 600 parts/);
  });

  it('refuse a tree that shows nothing', () => {
    expect(uiTreeProblem(root())).toMatch(/shows nothing/);
    expect(uiTreeProblem(root(' '))).toMatch(/shows nothing/);
    expect(uiTreeProblem(root('¿Seguimos?'))).toBeNull();
  });

  it('list the map addresses main must locate', () => {
    const tree = root({
      type: 'Map',
      props: {
        options: [
          { value: 'a', label: 'A', address: 'Calle Mayor 1, Madrid' },
          { value: 'b', label: 'B', address: 'Calle Mayor 1, Madrid' },
        ],
      },
      children: [],
    });
    expect(uiTreeAddresses(tree)).toEqual(['Calle Mayor 1, Madrid']);
  });
});
