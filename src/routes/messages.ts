
import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = Router();

router.use(requireAuth);

function formatConversation(row: any) {
  return {
    id: row.id,
    title: row.title,
    participants: row.participants,
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at,
    unread: row.unread
  };
}

function formatMessage(row: any) {
  return {
    id: row.id,
    from: row.sender,
    body: row.body,
    sentAt: row.sent_at,
    mine: row.mine
  };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .order('last_message_at', { ascending: false });

    if (error) throw error;

    return res.json({
      conversations: (data ?? []).map(formatConversation)
    });
  } catch {
    return res.status(500).json({
      error: 'Failed to load conversations.'
    });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    const { data: conversation, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;

    if (!conversation) {
      return res.status(404).json({
        error: 'Conversation not found.'
      });
    }

    const { data: messages, error: messagesError } =
      await supabase
        .from('chat_messages')
        .select('*')
        .eq('conversation_id', id)
        .order('sent_at', { ascending: true });

    if (messagesError) throw messagesError;

    return res.json({
      conversation: {
        ...formatConversation(conversation),
        messages: (messages ?? []).map(formatMessage)
      }
    });
  } catch {
    return res.status(500).json({
      error: 'Failed to load messages.'
    });
  }
});

export default router;
