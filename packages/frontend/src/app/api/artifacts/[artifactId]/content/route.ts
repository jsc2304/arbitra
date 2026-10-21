import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireArtifactCaseAccess } from '@/lib/api-helpers';
import {
  ASSISTANT_TASK_RESULT_SCHEMA_V1,
  ASSISTANT_TASK_RESULT_SCHEMA_V2,
  assertAssistantResultPolicyParity,
  parseAssistantTaskResult,
} from '@/lib/assistant-task-result';

export const dynamic = 'force-dynamic';

function dataUrlToResponse(dataUrl: string, filename: string): NextResponse {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) {
    return NextResponse.json(
      { error: { message: 'Artifact content is not readable' } },
      { status: 500 },
    );
  }

  const [, contentType, base64] = match;
  const body = Buffer.from(base64!, 'base64');
  return new NextResponse(body, {
    headers: {
      'content-type': contentType!,
      'content-disposition': `inline; filename="${filename.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=300',
    },
  });
}

function parseKnownAssistantResult(dataUrl: string) {
  const match = /^data:[^;]+;base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf-8')) as unknown;
  } catch {
    // Most artifacts are not assistant-result JSON. Their normal download path
    // must not become an integrity error merely because their bytes are opaque.
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const schema = (raw as { schema?: unknown }).schema;
  if (
    schema !== ASSISTANT_TASK_RESULT_SCHEMA_V1
    && schema !== ASSISTANT_TASK_RESULT_SCHEMA_V2
  ) return null;
  return parseAssistantTaskResult(dataUrl);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await params;

  try {
    const auth = await authenticate(request);
    const { ArtifactService, collections } = await import('@arbitra/backend');
    const doc = await collections.artifacts().doc(artifactId).get();

    if (!doc.exists) {
      return NextResponse.json(
        { error: { message: 'Artifact not found' } },
        { status: 404 },
      );
    }

    const artifact = doc.data()!;
    let caseId = artifact.case_id;
    if (!caseId && artifact.run_id) {
      const runDoc = await collections.runs().doc(artifact.run_id).get();
      caseId = runDoc.exists ? runDoc.data()!.case_id : undefined;
    }
    if (!caseId) {
      return NextResponse.json(
        { error: { message: 'Artifact is not linked to an accessible case' } },
        { status: 403 },
      );
    }

    if (caseId) {
      // Policy: see `requireArtifactCaseAccess` / `checkArtifactCaseAccess`
      // (backend `lib/project-access.ts`) — assistant-task cases are
      // requester-only here, with no admin bypass.
      const denied = await requireArtifactCaseAccess(caseId, auth.userId);
      if (denied) return denied;
    }

    const artifactService = new ArtifactService();
    const dataUrl = await artifactService.readContent(artifact.storage_path);
    try {
      const assistantResult = parseKnownAssistantResult(dataUrl);
      if (assistantResult?.schema === ASSISTANT_TASK_RESULT_SCHEMA_V2) {
        const runDoc = artifact.run_id
          ? await collections.runs().doc(artifact.run_id).get()
          : null;
        assertAssistantResultPolicyParity(
          assistantResult,
          runDoc?.exists ? runDoc.data()! : null,
        );
      }
    } catch (error) {
      console.error(`[ArtifactContent] Assistant result integrity check failed for ${artifactId}:`, error);
      return NextResponse.json(
        { error: { message: 'Assistant result integrity check failed' } },
        { status: 409 },
      );
    }
    return dataUrlToResponse(dataUrl, artifact.filename);
  } catch (error) {
    return handleError(error);
  }
}
