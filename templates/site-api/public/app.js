const form = document.getElementById("signup");
const status = document.getElementById("status");
const count = document.getElementById("count");

async function showCount() {
  const response = await fetch("/api/subscribers/count");
  if (response.ok) count.textContent = `${(await response.json()).count} subscribed so far`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Subscribing...";
  const response = await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: form.elements.email.value }),
  });
  const body = await response.json();
  status.textContent = response.ok
    ? body.already
      ? "You are already on the list."
      : "You are on the list."
    : body.error;
  if (response.ok) await showCount();
});

showCount();
