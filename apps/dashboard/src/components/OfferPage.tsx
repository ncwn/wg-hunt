import { Navigate, useParams } from "react-router";

/** An old `/offer/<id>` link: the Offers page with that Offer's card open. */
export function OfferPage() {
  const id = Number(useParams().id);
  return (
    <Navigate to={Number.isInteger(id) && id > 0 ? `/offers?offer=${id}` : "/offers"} replace />
  );
}
