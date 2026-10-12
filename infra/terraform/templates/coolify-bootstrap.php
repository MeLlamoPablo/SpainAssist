<?php

// Configures Coolify for this Terraform config. coolify-bootstrap.sh runs it inside the
// coolify container through `php artisan tinker`; secrets arrive as environment variables.
// Idempotent: safe on a fresh install and on every later bootstrap run.

use App\Models\InstanceSettings;
use App\Models\Server;
use App\Models\Team;
use App\Models\User;
use Illuminate\Support\Facades\Hash;

$env = function (string $key): string {
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException("$key is not set");
    }

    return $value;
};

// Root user (id 0, owner of the root team), as Coolify's first registration creates it. We
// create it ourselves instead of through the installer's ROOT_USER_* variables, which would
// leave the password in /data/coolify/source/.env.
$team = Team::find(0) ?? throw new RuntimeException('Root team (id 0) is missing');
$user = User::find(0) ?? (new User)->forceFill(['id' => 0]);
$user->forceFill([
    'name' => 'Admin',
    'email' => $env('SA_ROOT_EMAIL'),
    'password' => Hash::make($env('SA_ROOT_PASSWORD')),
    'email_verified_at' => $user->email_verified_at ?? now(),
]);
$user->save();
if (! $user->teams()->whereKey(0)->exists()) {
    $user->teams()->attach($team, ['role' => 'owner']);
}
// Servers, projects and resources come from Terraform: skip the onboarding wizard.
$team->forceFill(['show_boarding' => false])->save();

// API token for Terraform: Sanctum looks plain tokens up by their SHA-256.
$user->tokens()->where('name', 'terraform')->delete();
$user->tokens()->create([
    'name' => 'terraform',
    'token' => hash('sha256', $env('SA_API_TOKEN')),
    'abilities' => ['root'],
    'team_id' => 0,
]);

// Instance settings: API on, registration off, dashboard at https://coolify.<domain>.
$settings = InstanceSettings::get();
$settings->is_api_enabled = true;
$settings->is_registration_enabled = false;
$settings->fqdn = $env('SA_COOLIFY_URL');
$settings->save();

// Same as saving the instance domain in the UI: route it through Coolify's proxy.
Server::find(0)?->setupDynamicProxyConfiguration();

echo "coolify-bootstrap: configured\n";
