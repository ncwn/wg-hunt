import type { Place } from "../seeking.js";
import { Button } from "../ui/Button.js";
import { Segmented, TextField } from "../ui/controls.js";
import { NumberField } from "./fields.js";

const isPlz = (place: Place) => place.plz !== undefined;

function coordinates(name: string, lat: number | null, lng: number | null): Place {
  return { name, ...(lat !== null && { lat }), ...(lng !== null && { lng }) };
}

/** A place is a PLZ, whose centre the server looks up offline, or pasted coordinates. */
export function PlacesEditor({
  places,
  onChange,
}: {
  places: Place[];
  onChange: (places: Place[]) => void;
}) {
  const replace = (index: number, place: Place) =>
    onChange(places.map((each, i) => (i === index ? place : each)));

  return (
    <section className="pf-places" aria-labelledby="places-title">
      <div className="pf-places-head">
        <h3 id="places-title" className="pf-subtitle">
          Where do you need to get to?
        </h3>
        <Button size="sm" icon="plus" onClick={() => onChange([...places, { name: "", plz: "" }])}>
          Add a place
        </Button>
      </div>
      {places.length === 0 && <p className="pf-caption">No places yet.</p>}
      {places.map((place, index) => {
        const n = index + 1;
        return (
          // The rows have no id of their own; they are only ever edited in place.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <fieldset key={index} className="pf-place">
            <legend className="wh-sr">{`Place ${n}`}</legend>
            <div className="pf-place-grid">
              <TextField
                label="Name"
                type="text"
                autoComplete="off"
                placeholder="Work"
                aria-label={`Place ${n} name`}
                value={place.name}
                onChange={(event) => replace(index, { ...place, name: event.target.value })}
              />
              <div className="wh-field">
                <span className="wh-field-label" aria-hidden="true">
                  Found by
                </span>
                <Segmented
                  label={`Place ${n} located by`}
                  className="pf-place-by"
                  value={isPlz(place) ? "plz" : "coordinates"}
                  options={[
                    { value: "plz", label: "PLZ" },
                    { value: "coordinates", label: "Coordinates" },
                  ]}
                  onChange={(by) =>
                    replace(
                      index,
                      by === "plz" ? { name: place.name, plz: "" } : { name: place.name },
                    )
                  }
                />
              </div>
              {isPlz(place) ? (
                <TextField
                  label="PLZ"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="10115"
                  aria-label={`Place ${n} PLZ`}
                  value={place.plz ?? ""}
                  onChange={(event) =>
                    replace(index, { name: place.name, plz: event.target.value.trim() })
                  }
                />
              ) : (
                <div className="pf-pair">
                  <NumberField
                    label="Latitude"
                    spoken={`Place ${n} latitude`}
                    min={-90}
                    max={90}
                    value={place.lat ?? null}
                    onChange={(lat) =>
                      replace(index, coordinates(place.name, lat, place.lng ?? null))
                    }
                  />
                  <NumberField
                    label="Longitude"
                    spoken={`Place ${n} longitude`}
                    min={-180}
                    max={180}
                    value={place.lng ?? null}
                    onChange={(lng) =>
                      replace(index, coordinates(place.name, place.lat ?? null, lng))
                    }
                  />
                </div>
              )}
            </div>
            <Button
              size="sm"
              icon="trash"
              aria-label={`Remove Place ${n}`}
              onClick={() => onChange(places.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </fieldset>
        );
      })}
    </section>
  );
}
