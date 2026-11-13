import { createRoot } from "react-dom/client";
import { fleet } from "./fleet/store";
import { Fleet } from "./sections/fleet";
import { Hero } from "./sections/hero";
import { Upcoming } from "./sections/upcoming";
import { Footer, Nav } from "./system/chrome";

function Page() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Fleet />
        <Upcoming />
      </main>
      <Footer />
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Page />);
void fleet.start();
