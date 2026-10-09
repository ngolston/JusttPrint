/**
 * The page's own message and text prompt dialogs (styles: .jp-message-dialog). The server asks
 * for them too (server-dialog-request, bridge/server.ts), e.g. for Pull Metadata and errors.
 */

/** A message with buttons. Escape answers with the Cancel button (the last of several). */
export function showBrowserMessage(
  title: string,
  message: string,
  buttons: string[] = ['OK'],
  cancelIndex = buttons.length > 1 ? buttons.length - 1 : 0
): Promise<{ label: string; index: number }> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.id = `browser-message-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    dialog.className = 'jp-message-dialog';
    dialog.setAttribute('aria-modal', 'true');

    const titleEl = document.createElement('div');
    titleEl.textContent = title || 'Message';
    titleEl.className = 'jp-message-dialog__title';
    const messageEl = document.createElement('div');
    messageEl.textContent = message || '';
    messageEl.className = 'jp-message-dialog__text';
    const buttonRow = document.createElement('div');
    buttonRow.className = 'jp-message-dialog__buttons';

    const finish = (index: number) => {
      dialog.close();
      dialog.remove();
      resolve({ label: buttons[index], index });
    };
    buttons.forEach((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = `jp-btn ${index === 0 ? 'jp-btn--primary' : 'jp-btn--secondary'}`;
      button.addEventListener('click', () => finish(index));
      buttonRow.appendChild(button);
    });
    // Escape answers instead of leaving the caller waiting.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(cancelIndex);
    });

    dialog.append(titleEl, messageEl, buttonRow);
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

export interface InputOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
}

/** A text prompt. Resolves to the entered text, or null when cancelled. */
export function showBrowserInput(options: InputOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'jp-message-dialog browser-input-dialog';
    dialog.setAttribute('aria-modal', 'true');
    const form = document.createElement('form');
    form.method = 'dialog';

    const titleEl = document.createElement('div');
    titleEl.textContent = options.title || 'Input';
    titleEl.className = 'jp-message-dialog__title';
    const label = document.createElement('label');
    label.textContent = options.message || '';
    label.className = 'jp-message-dialog__text';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = options.defaultValue || '';
    input.placeholder = options.placeholder || '';
    input.className = 'jp-message-dialog__input';
    label.appendChild(input);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'jp-message-dialog__buttons';
    const button = (text: string, primary: boolean, type: 'submit' | 'button') => {
      const el = document.createElement('button');
      el.type = type;
      el.textContent = text;
      el.className = `jp-btn ${primary ? 'jp-btn--primary' : 'jp-btn--secondary'}`;
      return el;
    };
    const cancel = button('Cancel', false, 'button');
    buttonRow.append(cancel, button('OK', true, 'submit'));

    let answer: string | null = null;
    form.addEventListener('submit', () => {
      answer = input.value;
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });

    form.append(titleEl, label, buttonRow);
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    dialog.showModal();
    input.select();
  });
}
