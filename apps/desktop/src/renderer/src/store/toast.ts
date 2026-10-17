import { create } from 'zustand';

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  title: string;
  description?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    window.setTimeout(() => get().dismiss(id), toast.kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: 'info', title, description }),
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: 'success', title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: 'error', title, description }),
};
