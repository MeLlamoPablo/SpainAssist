import { defineDict } from '../../i18n';

export const codemodeDict = defineDict({
  es: {
    /** The questions above the cards, for screen readers (no heading on screen). */
    forYou: 'Preguntas para ti',
    closed: 'Esta pregunta ya no está abierta.',
    chooseOne: 'Elige una opción',
    province: 'Provincia',
    place: 'Lugar',
    appointment: 'Cita',
    dismiss: 'Descartar',
    dismissTitle: 'Descartar esta pregunta',
    dismissed: 'Pregunta descartada',
    unshowable: 'Se lo he dicho al asistente para que te pregunte de otra forma.',
    /** Procedure rows (the classic card's strings are in procedures/i18n.ts). */
    row: {
      needs: 'Necesitas',
      requirements: 'Requisitos',
      moreRequirements: (n: number) => (n === 1 ? '+ 1 requisito' : `+ ${n} requisitos`),
      waitingOn: (name?: string) =>
        name ? `Esperando a ${name}` : 'Esperando a la administración',
      plan: 'Plan',
    },
    meter: {
      label: 'Lo que estoy haciendo',
      stop: 'Detener',
      more: (n: number) => (n === 1 ? 'Ver 1 más' : `Ver ${n} más`),
      less: 'Ver menos',
      waiting: 'Necesito que hagas algo',
      researching: 'Investigando',
    },
  },
  en: {
    forYou: 'Questions for you',
    closed: 'This question is no longer open.',
    chooseOne: 'Choose one',
    province: 'Province',
    place: 'Place',
    appointment: 'Appointment',
    dismiss: 'Dismiss',
    dismissTitle: 'Dismiss this question',
    dismissed: 'Question dismissed',
    unshowable: 'I’ve told the assistant, so it can ask you another way.',
    row: {
      needs: 'You need',
      requirements: 'Requirements',
      moreRequirements: (n: number) => (n === 1 ? '+ 1 requirement' : `+ ${n} requirements`),
      waitingOn: (name?: string) =>
        name ? `Waiting for ${name}` : 'Waiting for the administration',
      plan: 'Plan',
    },
    meter: {
      label: 'What I am doing',
      stop: 'Stop',
      more: (n: number) => (n === 1 ? 'See 1 more' : `See ${n} more`),
      less: 'See less',
      waiting: 'I need you to do something',
      researching: 'Researching',
    },
  },
});
