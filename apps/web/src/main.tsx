import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "@/components/layout.tsx";
import { HistoryPage } from "@/pages/history.tsx";
import { HomePage } from "@/pages/home.tsx";
import { ReportPage } from "@/pages/report.tsx";
import { WorkspacePage } from "@/pages/workspace.tsx";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/runs", element: <HistoryPage /> },
      { path: "/runs/:id", element: <WorkspacePage /> },
      { path: "/runs/:id/report", element: <ReportPage /> },
      { path: "*", element: <p className="text-muted-foreground">Page not found.</p> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
