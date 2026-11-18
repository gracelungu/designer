<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>
<template><header>{{ title }}</header></template>
