import type { FastifyInstance } from 'fastify';
import type { InterviewAnswerDto, InterviewDto, InterviewOptionsDto } from '@sandbox/shared';
import {
  interviewCatalog,
  interviewDto,
  logAction,
  saveNotes,
  startInterview,
  submitInterview,
  takeHint,
  type World,
} from '@sandbox/sim';
import { aiErrorMessage, type AiGrader } from './aiGrader';

/**
 * Interview mode and the action log. The wall clock is read here, in the server, never in the
 * simulation: the interview timer runs on real time while the world runs on sim time.
 */
export function registerInterview(app: FastifyInstance, world: World, aiGrader: AiGrader | null): void {
  const text = (max: number) => ({ type: 'string', maxLength: max }) as const;

  app.post<{ Body: { page: string } }>(
    '/api/actions/page',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['page'],
          properties: { page: { type: 'string', pattern: '^[a-z][a-z0-9/-]{0,63}$' } },
        },
      },
    },
    async (req) => {
      logAction(world, { kind: 'page', text: req.body.page }, Date.now());
      return { ok: true };
    },
  );

  app.get('/api/interview/catalog', async () => interviewCatalog(world, !!aiGrader));

  app.get('/api/interviews', async () => [...world.interviews].reverse().map(interviewDto));

  app.get('/api/interviews/current', async () => {
    const i = world.interviews.find((x) => x.status === 'running');
    return { interview: i ? interviewDto(i) : null, now: Date.now() };
  });

  app.post<{ Body: InterviewOptionsDto }>(
    '/api/interviews',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scenarioId: text(64),
            topic: text(64),
            difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
            timeLimitMinutes: { type: 'integer', minimum: 5, maximum: 120 },
          },
        },
      },
    },
    async (req) => interviewDto(startInterview(world, req.body, Date.now())),
  );

  app.post<{ Params: { id: string } }>('/api/interviews/:id/hint', async (req) =>
    interviewDto(takeHint(world, req.params.id, Date.now())),
  );

  app.put<{ Params: { id: string }; Body: { notes: string } }>(
    '/api/interviews/:id/notes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['notes'],
          properties: { notes: text(20_000) },
        },
      },
    },
    async (req) => interviewDto(saveNotes(world, req.params.id, req.body.notes)),
  );

  app.post<{ Params: { id: string }; Body: { answer: InterviewAnswerDto } }>(
    '/api/interviews/:id/submit',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['answer'],
          properties: {
            answer: {
              type: 'object',
              additionalProperties: false,
              required: ['rootCause', 'fix', 'verification', 'prevention'],
              properties: {
                rootCause: text(4000),
                fix: text(4000),
                verification: text(4000),
                prevention: text(4000),
              },
            },
          },
        },
      },
    },
    async (req): Promise<InterviewDto> => {
      const i = submitInterview(world, req.params.id, req.body.answer, Date.now());
      if (aiGrader) {
        const s = world.scenarios.definitions.find((d) => d.id === i.scenarioId)!;
        try {
          i.debrief!.ai = await aiGrader({
            title: s.title,
            prompt: i.prompt,
            summary: s.summary,
            modelAnswer: i.debrief!.modelAnswer,
            answer: i.answer!,
          });
        } catch (e) {
          req.log.warn({ err: e }, 'Claude grading failed');
          i.debrief!.aiError = aiErrorMessage(e);
        }
      }
      return interviewDto(i);
    },
  );
}
