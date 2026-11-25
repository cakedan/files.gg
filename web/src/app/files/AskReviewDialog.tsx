import { useId, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import type { OwnerFile } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useRequestNsfwReview } from '../../lib/queries';
import { Dialog } from '../components/Dialog';

/** "Ask for review" of an automatic NSFW mark (milestone-4 §4.5): once per file. */
export function AskReviewDialog({ file, onClose, onDone }: { file: OwnerFile; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const review = useRequestNsfwReview();
  const [message, setMessage] = useState('');
  return (
    <Dialog
      title="Ask for a review"
      description={`files.gg’s classifier marked ${file.filename} as sensitive. If that’s wrong, a moderator checks it. You can ask once for each file.`}
      onClose={onClose}
      initialFocus={fieldRef}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={review.isPending}
            onClick={() => review.mutate({ id: file.id, message: message.trim() || undefined }, { onSuccess: onDone })}
          >
            {review.isPending ? 'Sending…' : 'Ask for review'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-message`} className="text-sm font-medium">
          Anything the moderator should know (optional)
        </label>
        <textarea
          ref={fieldRef}
          id={`${id}-message`}
          value={message}
          maxLength={2000}
          rows={3}
          onChange={(event) => setMessage(event.target.value)}
          className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm"
        />
        {review.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(review.error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
