import { NextRequest, NextResponse } from 'next/server';
import { WebhookService, validateBody, verifyCIWebhookSignature } from '@arbitra/backend';
import { ciWebhookSchema } from '@arbitra/shared';
import { handleError } from '@/lib/api-helpers';

const webhookService = new WebhookService();

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get('x-hub-signature-256');
    const rawBody = await request.text();

    if (!signature) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing X-Hub-Signature-256 header — configure a secret on the CI webhook' } },
        { status: 401 },
      );
    }

    const secret = process.env.CI_WEBHOOK_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: { code: 'SERVER_ERROR', message: 'Webhook secret not configured' } },
        { status: 500 },
      );
    }

    if (!verifyCIWebhookSignature(rawBody, signature, secret)) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature' } },
        { status: 401 },
      );
    }

    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const payload = validateBody(ciWebhookSchema, body);

    const result = await webhookService.handleCIWebhook(payload);
    if (!result.ok) {
      if (result.reason === 'case_not_found') {
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: `Case not found: ${payload.case_id ?? ''}` } },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { error: 'case_id is required' },
        { status: 400 },
      );
    }
    return NextResponse.json({ status: 'processed', build_id: payload.build_id });
  } catch (error) {
    return handleError(error);
  }
}
