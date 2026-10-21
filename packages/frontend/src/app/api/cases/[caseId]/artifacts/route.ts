import { NextRequest, NextResponse } from 'next/server';
import { validateBody } from '@arbitra/backend';
import { createArtifactSchema } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  try {
    const auth = await authenticate(_request);
    const denied = await requireCaseAccess(caseId, auth.userId);
    if (denied) return denied;
    const { collections } = await import('@arbitra/backend');
    const snapshot = await collections.artifacts()
      .where('case_id', '==', caseId)
      .orderBy('created_at', 'desc')
      .get();
    const artifacts = snapshot.docs.map((doc) => doc.data());
    return NextResponse.json({ artifacts });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;

  // Production: store file + persist metadata to Firestore
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(caseId, auth.userId);
    if (denied) return denied;
    const body = await request.json();
    const input = validateBody(createArtifactSchema, body);

    const { ArtifactService, collections } = await import('@arbitra/backend');
    const artifactService = new ArtifactService();

    const artifact = await artifactService.createFromBase64({
      caseId,
      filename: input.filename,
      contentType: input.content_type,
      base64Data: input.data,
      actorId: auth.userId,
    });

    // Persist artifact metadata to Firestore
    await collections.artifacts().doc(artifact.artifact_id).set(artifact);

    return NextResponse.json(artifact, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
