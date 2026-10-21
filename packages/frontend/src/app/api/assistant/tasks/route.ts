import { NextRequest, NextResponse } from 'next/server';
import { AssistantIntakeService, CaseService, clerkCoreIds, validateBody } from '@arbitra/backend';
import { webAssistantIntakeSchema } from '@arbitra/shared';
import { authenticate, handleError } from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';
import { scheduleAssistantRunDispatch } from '@/lib/assistant-run-dispatch';

export const dynamic = 'force-dynamic';

const intakeService = new AssistantIntakeService();

/** How many recent tasks the ask surface lists without being asked for more. */
const DEFAULT_TASK_LIST_LIMIT = 10;
const MAX_TASK_LIST_LIMIT = 50;

/**
 * Hand the freshly created run to the in-process executor without making the
 * requester wait for it. Same fire-and-forget idiom as
 * `scheduleReviewNotApplicableHeal` in `api/cases/[caseId]/route.ts`: a
 * `void Promise.resolve().then(...)` scheduled before the response is returned,
 * with every error swallowed into a `console.warn` so it can never affect the
 * response.
 *
 * Safe to lose. The run is created `awaiting_claim`, so if this process dies
 * before the executor claims it, the assistant sub-sweep in `RunSweepService`
 * dispatches it instead; and if both get there, `claimRun` lets exactly one
 * win. This scheduling only removes the wait for that sweep — it is not what
 * makes the run reachable.
 */
/**
 * `GET /api/assistant/tasks` — the signed-in user's own recent Clerk tasks.
 *
 * Scoped by the Clerk project derived from the caller's user id, which is what
 * makes this safe without a project-access guard: `clerkCoreIds` cannot name
 * another user's project, and a Clerk project's membership is that one user.
 * The project scope also keeps the query on an index that already exists
 * (`deleted_at`, `project_id`, `updated_at`) instead of needing a new
 * `case_type`-ordered one; the `case_type` check afterwards is belt and braces,
 * since nothing but assistant tasks is ever created in a Clerk project.
 *
 * An unprovisioned caller gets an empty list rather than an error: they have no
 * tasks yet, which is exactly what an empty list says. Provisioning happens on
 * their first submission.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const requested = Number.parseInt(
      request.nextUrl.searchParams.get('limit') ?? '',
      10,
    );
    const limit = Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_TASK_LIST_LIMIT)
      : DEFAULT_TASK_LIST_LIMIT;

    const { cases } = await new CaseService().listCases({
      project_id: clerkCoreIds(auth.userId).projectId,
      limit,
    });

    return NextResponse.json({
      tasks: cases
        .filter((case_) => case_.case_type === 'assistant_task')
        .map((case_) => ({
          case_id: case_.case_id,
          title: case_.title,
          status: case_.status,
          created_at: case_.created_at,
          updated_at: case_.updated_at,
          // Lets the list group a follow-up under its root (assistant_thread
          // is already on `case_` from the same read above — no extra
          // fetch). Only the one field the grouping needs, same "just the
          // fields the list needs" narrowing as everything else here.
          ...(case_.assistant_thread
            ? { assistant_thread: { root_case_id: case_.assistant_thread.root_case_id } }
            : {}),
          // Occurrence provenance for the Scheduled tab's per-blueprint
          // grouping (clerk-scheduled-panel.tsx). `blueprint_id` is the flat
          // reference `AssistantIntakeService` stamps at intake time;
          // `blueprint_version` comes from the immutable `blueprint_context`
          // snapshot taken at that same moment — not from the (mutable)
          // `TaskBlueprint` row — so it names the version that was EFFECTIVE
          // when this occurrence was created, not whatever the blueprint has
          // since been edited to. Both are absent on a case not created from
          // a blueprint. `reads_withheld` is stamped by the executor once the
          // run finishes (`AssistantTaskExecutor`'s `done`-transition write);
          // absent on a still-running occurrence.
          ...(case_.assistant_context?.blueprint_id
            ? { blueprint_id: case_.assistant_context.blueprint_id }
            : {}),
          ...(case_.assistant_context?.blueprint_context?.blueprint_version !== undefined
            ? { blueprint_version: case_.assistant_context.blueprint_context.blueprint_version }
            : {}),
          ...(case_.assistant_context?.reads_withheld !== undefined
            ? { reads_withheld: case_.assistant_context.reads_withheld }
            : {}),
        })),
    });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * `POST /api/assistant/tasks` — accept one assistant task from the signed-in
 * user and return the case it is tracked on.
 *
 * Path rationale: the created resource is an assistant task, so it sits under
 * the plural collection noun the rest of this API uses for creation
 * (`/api/cases`, `/api/runs`, `/api/rules`), and the `assistant/` segment
 * reserves a home for the surface's other entry points the way `agent/` and
 * `webhooks/` already do — the Google Chat webhook becomes
 * `/api/assistant/chat/...` without disturbing this route. Naming it
 * `/api/cases/assistant` was the alternative and was rejected: the case is an
 * implementation detail of how a task is tracked, not the resource the caller
 * asks for, and it would collide with the `[caseId]` segment.
 *
 * There is no project-access guard here because there is no caller-supplied
 * project to guard: the Clerk project is derived from the caller's own user id,
 * and `AssistantIntakeService` verifies membership of it before any write.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    const input = validateBody(webAssistantIntakeSchema, body);

    // Provenance is owned by this entry point, never by the browser payload.
    // The strict web schema cannot express Google Chat coordinates either.
    const result = await intakeService.intake({ ...input, channel: 'web' }, auth.userId);

    if (result.run) {
      scheduleAssistantRunDispatch(result.case, result.run);
    }

    const share_url = resolveCaseShareUrl(request, result.case.case_id, result.case.status);
    return NextResponse.json(
      {
        case_id: result.case.case_id,
        run_id: result.run_id,
        status: result.case.status,
        replayed: result.replayed,
        ...(share_url ? { share_url } : {}),
      },
      // A replay created nothing, so it is a 200, not a 201.
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return handleError(error);
  }
}
