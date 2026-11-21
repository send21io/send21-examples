import { createAction, Property } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { send21Auth } from '../auth';
import { authKey, send21Request } from '../common/client';

export const getDraft = createAction({
  auth: send21Auth,
  name: 'get_draft',
  displayName: 'Get Draft',
  description: 'Read a draft, including amounts, fee, quote and core hash (GET /drafts/{id}).',
  props: {
    draftId: Property.ShortText({
      displayName: 'Draft ID',
      required: true,
    }),
  },
  async run(context) {
    return send21Request({
      apiKey: authKey(context.auth),
      method: HttpMethod.GET,
      path: `/drafts/${context.propsValue.draftId}`,
    });
  },
});

export const getDraftStatus = createAction({
  auth: send21Auth,
  name: 'get_draft_status',
  displayName: 'Get Draft Status',
  description:
    'Read the status snapshot: AwaitingPayment, Seen, Confirmed, Expired or Cancelled (GET /drafts/{id}/status). Prefer the webhook trigger over polling.',
  props: {
    draftId: Property.ShortText({
      displayName: 'Draft ID',
      required: true,
    }),
  },
  async run(context) {
    return send21Request({
      apiKey: authKey(context.auth),
      method: HttpMethod.GET,
      path: `/drafts/${context.propsValue.draftId}/status`,
    });
  },
});
