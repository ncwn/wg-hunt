import type { Place, SeekerProfile } from "../seeking.js";
import { DateField, SettingRow, Toggle } from "../ui/controls.js";
import { ListField, NumberField, OptionalSelect, optionsOf, TriStateSelect } from "./fields.js";
import { PlacesEditor } from "./PlacesEditor.js";

type Answer<K extends keyof SeekerProfile> = NonNullable<SeekerProfile[K]>;

// Typed as records so that an answer added to the API fails to compile here.
const GENDERS = optionsOf<Answer<"gender">>({ woman: "Woman", man: "Man", diverse: "Diverse" });
const DIETS = optionsOf<Answer<"diet">>({
  omnivore: "Eats everything",
  vegetarian: "Vegetarian",
  vegan: "Vegan",
});
const OCCUPATIONS = optionsOf<Answer<"occupation">>({
  student: "Student",
  working: "Working",
  trainee: "Trainee",
});

/** Refusals name answers by these too. */
export const PROFILE_QUESTIONS: Record<keyof SeekerProfile, string> = {
  gender: "What's your gender?",
  age: "How old are you?",
  occupation: "What do you do?",
  diet: "What do you eat?",
  smoker: "Do you smoke?",
  hasPets: "Do you have pets?",
  languages: "Which languages do you speak?",
  anmeldungNeeded: "Do you need Anmeldung?",
  moveIn: "When do you want to move in?",
  stay: "How long do you want to stay?",
  places: "Where do you need to get to?",
};

export function ProfileEditor({
  profile,
  onChange,
  onPlaces,
}: {
  profile: SeekerProfile;
  onChange: (profile: SeekerProfile) => void;
  onPlaces: (places: Place[]) => void;
}) {
  const set = <K extends keyof SeekerProfile>(key: K, value: SeekerProfile[K]) =>
    onChange({ ...profile, [key]: value });

  return (
    <div>
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.gender}
        control={
          <OptionalSelect
            label="Gender"
            value={profile.gender}
            options={GENDERS}
            onChange={(gender) => set("gender", gender)}
          />
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.age}
        control={
          <NumberField
            bare
            integer
            label="Age"
            suffix="years"
            min={16}
            max={120}
            value={profile.age}
            onChange={(age) => set("age", age)}
          />
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.occupation}
        control={
          <OptionalSelect
            label="Occupation"
            value={profile.occupation}
            options={OCCUPATIONS}
            onChange={(occupation) => set("occupation", occupation)}
          />
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.diet}
        control={
          <OptionalSelect
            label="Diet"
            value={profile.diet}
            options={DIETS}
            onChange={(diet) => set("diet", diet)}
          />
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.smoker}
        control={
          <TriStateSelect
            label="Smoker"
            value={profile.smoker}
            onChange={(v) => set("smoker", v)}
          />
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.hasPets}
        control={
          <TriStateSelect
            label="Has pets"
            value={profile.hasPets}
            onChange={(v) => set("hasPets", v)}
          />
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.languages}
        control={
          <ListField
            bare
            label="Languages spoken"
            placeholder="de, en"
            value={profile.languages}
            onChange={(languages) => set("languages", languages)}
            transform={(code) => code.toLowerCase()}
          />
        }
      />
      <SettingRow
        title={PROFILE_QUESTIONS.anmeldungNeeded}
        control={
          <Toggle
            label="Needs Anmeldung"
            checked={profile.anmeldungNeeded}
            onChange={(anmeldungNeeded) => set("anmeldungNeeded", anmeldungNeeded)}
          />
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.moveIn}
        control={
          <div className="pf-pair">
            <DateField
              label="Move in from"
              value={profile.moveIn.earliest}
              onChange={(earliest) => set("moveIn", { ...profile.moveIn, earliest })}
            />
            <DateField
              label="Move in by"
              value={profile.moveIn.latest}
              {...(profile.moveIn.earliest && { min: profile.moveIn.earliest })}
              onChange={(latest) => set("moveIn", { ...profile.moveIn, latest })}
            />
          </div>
        }
      />
      <SettingRow
        layout="field"
        title={PROFILE_QUESTIONS.stay}
        control={
          <div className="pf-pair">
            <NumberField
              integer
              min={1}
              label="At least"
              spoken="Stay at least (months)"
              suffix="months"
              value={profile.stay.minMonths}
              onChange={(minMonths) => set("stay", { ...profile.stay, minMonths })}
            />
            <NumberField
              integer
              min={1}
              label="At most"
              spoken="Stay at most (months)"
              suffix="months"
              value={profile.stay.maxMonths}
              onChange={(maxMonths) => set("stay", { ...profile.stay, maxMonths })}
            />
          </div>
        }
      />
      <PlacesEditor places={profile.places} onChange={onPlaces} />
    </div>
  );
}
