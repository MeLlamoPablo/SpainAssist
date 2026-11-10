import type { UiElement } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { describeFailure } from './failures';

describe('what the app tells a workflow it could not draw', () => {
  it('names the component, its label and the workflow’s components that rendered it', () => {
    const node: UiElement = {
      type: 'Appointment',
      props: {
        label: 'Cita',
        slots: ['2026-10-19T09:30'],
        value: 'mañana',
        onChange: { $handler: 'r.0:CitaForm/2:Picker/0#onChange' },
      },
      children: [],
    };
    expect(describeFailure(node, new RangeError('Invalid time value'))).toBe(
      '<Appointment label="Cita"> in CitaForm > Picker (RangeError: Invalid time value)',
    );
  });

  it('names a button by its text', () => {
    const button: UiElement = {
      type: 'Button',
      props: { onClick: { $handler: 'r.0:Cita/3#onClick' } },
      children: ['Buscar cita'],
    };
    expect(describeFailure(button, new RangeError('Invalid time value'))).toBe(
      '<Button label="Buscar cita"> in Cita (RangeError: Invalid time value)',
    );
  });

  it('says what it can without a label, handlers or the node', () => {
    expect(describeFailure({ type: 'Divider', props: {}, children: [] }, 'boom')).toBe(
      '<Divider> (boom)',
    );
    expect(describeFailure(undefined, new TypeError('x is undefined'))).toBe(
      'it (TypeError: x is undefined)',
    );
  });
});
