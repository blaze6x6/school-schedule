import { Router } from 'express';
import { query, queryOne, execute } from '../db.js';
import { authMiddleware, adminMiddleware } from '../auth.js';
import { notifyAllWithCalendar } from '../mailer.js';
import { notifyAllInApp } from '../notify.js';

const router = Router();

router.use(authMiddleware);

// ----- helpers -----

interface EventRow {
  id: string;
  event_date: Date;
  title: string;
  color: string;
  class_ids: string[];
  start_time: string | null;
  end_time: string | null;
  recurrence: string;
}

function mapEvent(e: EventRow) {
  return {
    id: e.id,
    date: e.event_date.toISOString().split('T')[0],
    title: e.title,
    color: e.color,
    classIds: e.class_ids || [],
    startTime: e.start_time?.substring(0, 5) || '00:00',
    endTime: e.end_time?.substring(0, 5) || '23:59',
    recurrence: e.recurrence || 'none',
  };
}

// Build a WHERE clause that matches a given date ($dateParam) against recurrence.
// dateParam is the SQL placeholder like '$1'.
function recurrenceWhere(dateParam: string): string {
  // In PostgreSQL, (date - date) yields an integer (number of days).
  // EXTRACT(ISODOW FROM date) yields 1=Mon … 7=Sun.
  const d = `${dateParam}::date`;
  return `(
    (recurrence = 'none'      AND event_date = ${d})
    OR
    (recurrence = 'daily'     AND event_date <= ${d})
    OR
    (recurrence = 'weekly'    AND event_date <= ${d}
                              AND EXTRACT(ISODOW FROM event_date) = EXTRACT(ISODOW FROM ${d}))
    OR
    (recurrence = 'biweekly'  AND event_date <= ${d}
                              AND EXTRACT(ISODOW FROM event_date) = EXTRACT(ISODOW FROM ${d})
                              AND MOD( (${d} - event_date) / 7 , 2) = 0)
    OR
    (recurrence = 'triweekly' AND event_date <= ${d}
                              AND EXTRACT(ISODOW FROM event_date) = EXTRACT(ISODOW FROM ${d})
                              AND MOD( (${d} - event_date) / 7 , 3) = 0)
    OR
    (recurrence = 'monthly'   AND event_date <= ${d}
                              AND EXTRACT(DAY FROM event_date) = EXTRACT(DAY FROM ${d}))
  )`;
}

const RETURNING = `RETURNING id, event_date, title, color, class_ids, start_time::text, end_time::text, recurrence`;

// ----- routes -----

// Get all events (admin list – one row per event definition)
router.get('/', async (_req, res) => {
  try {
    const events = await query<EventRow>(
      `SELECT id, event_date, title, color, class_ids, start_time::text, end_time::text, recurrence
       FROM day_events
       ORDER BY event_date, start_time`
    );
    res.json(events.map(mapEvent));
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Error retrieving events' });
  }
});

// Get events for a class on a specific date (recurrence-aware)
// $1 = date, $2 = classId
router.get('/time-events', async (req, res) => {
  try {
    const { classId, date } = req.query;
    if (!classId || !date) {
      return res.status(400).json({ error: 'Class and date are required' });
    }

    const sql = `
      SELECT id, event_date, title, color, class_ids, start_time::text, end_time::text, recurrence
      FROM day_events
      WHERE start_time IS NOT NULL
        AND end_time IS NOT NULL
        AND (class_ids = '{}' OR $2::uuid = ANY(class_ids))
        AND ${recurrenceWhere('$1')}
      ORDER BY start_time
    `;

    const events = await query<EventRow>(sql, [date, classId]);
    res.json(events.map(mapEvent));
  } catch (error) {
    console.error('Get time events error:', error);
    res.status(500).json({ error: 'Error retrieving events' });
  }
});

// Create event
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { date, title, color, classIds, startTime, endTime, recurrence } = req.body;

    if (!date || !title || !color || !startTime || !endTime) {
      return res.status(400).json({ error: 'Date, title, color, start and end are required.' });
    }
    if (startTime >= endTime) {
      return res.status(400).json({ error: 'Start time must be before end time' });
    }

    const event = await queryOne<EventRow>(
      `INSERT INTO day_events (event_date, title, color, class_ids, is_all_day, start_time, end_time, recurrence)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7)
       ${RETURNING}`,
      [date, title, color, classIds || [], startTime, endTime, recurrence || 'none']
    );

    res.status(201).json(mapEvent(event!));
    const recLabels: Record<string, string> = {
      none: '', daily: ' (every day)', weekly: ' (every week)',
      biweekly: ' (every other week)', triweekly: ' (every third week)', monthly: ' (every month)',
    };
    notifyAllWithCalendar(
      'New event: ' + title,
      `<p>A new event has been added.: <strong>${title}</strong></p>
       <p>Date: ${date}, ${startTime} – ${endTime}${recLabels[recurrence || 'none'] || ''}</p>
       <p><small>Open the attached .ics file to add to Google Calendar or another calendar.</small></p>`,
      { title, date, startTime, endTime, recurrence: recurrence || 'none', description: title }
    ).catch(() => {});
    notifyAllInApp(`New event: ${title} (${date}, ${startTime}–${endTime})`, 'info').catch(() => {});
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Error creating event' });
  }
});

// Update event
router.put('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, title, color, classIds, startTime, endTime, recurrence } = req.body;

    if (startTime && endTime && startTime >= endTime) {
      return res.status(400).json({ error: 'Start time must be before end time' });
    }

    const event = await queryOne<EventRow>(
      `UPDATE day_events SET
        event_date = COALESCE($1, event_date),
        title      = COALESCE($2, title),
        color      = COALESCE($3, color),
        class_ids  = COALESCE($4, class_ids),
        start_time = COALESCE($5, start_time),
        end_time   = COALESCE($6, end_time),
        recurrence = COALESCE($7, recurrence),
        is_all_day = false
       WHERE id = $8
       ${RETURNING}`,
      [date || null, title || null, color || null, classIds ?? null,
       startTime || null, endTime || null, recurrence || null, id]
    );

    if (!event) {
      return res.status(404).json({ error: 'The event does not exist.' });
    }
    res.json(mapEvent(event));
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Error updating event' });
  }
});

// Delete event
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('Deleting event:', id);
    const count = await execute('DELETE FROM day_events WHERE id = $1', [id]);
    console.log('Deleted rows:', count);
    if (count === 0) {
      return res.status(404).json({ error: 'The event does not exist.' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Error deleting event' });
  }
});

export default router;
