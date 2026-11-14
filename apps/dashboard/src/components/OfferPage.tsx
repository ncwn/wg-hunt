import { Navigate, useParams } from "react-router";

export function OfferPage() {
  const id = Number(useParams().id);
  return (
    <Navigate to={Number.isInteger(id) && id > 0 ? `/offers?offer=${id}` : "/offers"} replace />
  );
}
