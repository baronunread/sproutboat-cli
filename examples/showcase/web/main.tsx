import { createRoot } from "react-dom/client";
import { fleet } from "./fleet/store";
import { Compared } from "./sections/compared";
import { Fleet } from "./sections/fleet";
import { Upcoming } from "./sections/upcoming";
import { Footer, Nav } from "./system/chrome";

function Page() {
  return (
    <>
      <Nav />
      <main>
        <Fleet />
        <Upcoming />
        <Compared />
      </main>
      <Footer />
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Page />);
void fleet.start();
