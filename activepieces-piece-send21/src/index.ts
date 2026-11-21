import { createPiece } from '@activepieces/pieces-framework';
import { send21Auth } from './lib/auth';
import { actions } from './lib/actions';
import { triggers } from './lib/triggers';

export { send21Auth };

export const send21 = createPiece({
  displayName: 'send21',
  description:
    'Crypto pay links and payment drafts. A flow prepares them; a person signs and sends from their own wallet. send21 never holds keys or funds.',
  minimumSupportedRelease: '0.88.2',
  logoUrl: 'https://raw.githubusercontent.com/send21io/send21io/main/assets/send21-logo-512.png',
  authors: ['send21'],
  auth: send21Auth,
  actions,
  triggers,
});
