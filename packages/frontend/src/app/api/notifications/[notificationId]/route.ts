import { NextRequest, NextResponse } from 'next/server';
import { NotificationService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

const notificationService = new NotificationService();

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ notificationId: string }> }
) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    await notificationService.delete(params.notificationId, auth.userId);
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    return handleError(error);
  }
}
