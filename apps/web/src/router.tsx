import { createBrowserRouter } from "react-router-dom";
import { HomePage } from "./features/public-booking/home-page";
import { DashboardPage } from "./features/dashboard/dashboard-page";

// Two faces, one SPA: public funnel + (auth-guarded, later) dashboard.
// (architecture.md §4.2)
export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/app", element: <DashboardPage /> },
]);
