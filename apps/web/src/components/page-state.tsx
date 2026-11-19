import { CircleAlert, type LucideIcon, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ApiError } from "@/api.ts";
import { EmptyState } from "@/components/empty-state.tsx";
import { Button } from "@/components/ui/button.tsx";

/** A page that is only a message: its title is the page's `h1`, followed by a link back. */
function PageState({
  icon,
  title,
  body,
  back,
}: {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  back: { to: string; label: string };
}) {
  return (
    <div className="px-4 py-8">
      <EmptyState
        icon={icon}
        headingLevel={1}
        title={title}
        body={body}
        className="mx-auto max-w-xl"
        action={
          <Button asChild variant="outline">
            <Link to={back.to}>{back.label}</Link>
          </Button>
        }
      />
    </div>
  );
}

export function NotFoundPage() {
  return (
    <PageState
      icon={SearchX}
      title="Page not found"
      body="There is no page at this address."
      back={{ to: "/", label: "Back to Home" }}
    />
  );
}

/** The workspace or report of a run that could not be loaded. */
export function RunLoadError({ error }: { error: ApiError }) {
  const unknown = error.status === 404;
  return (
    <PageState
      icon={unknown ? SearchX : CircleAlert}
      title={unknown ? "Unknown run" : "The run could not be loaded"}
      body={
        unknown
          ? "No run with this id exists on this server. It may have been deleted."
          : error.message
      }
      back={{ to: "/runs", label: "Back to history" }}
    />
  );
}
